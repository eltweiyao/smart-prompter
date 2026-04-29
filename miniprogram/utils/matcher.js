/**
 * SmartMatcher - speech follow matcher.
 *
 * The matcher only advances after a confident ASR/script match. It does not
 * predict progress during silence and does not move the displayed text back.
 */

const { normalizeText, CONFIG } = require('./helpers.js');

const CLEAN_REGEX = /[\u4e00-\u9fa5a-zA-Z0-9]/;

class SmartMatcher {
  constructor(script, startIndex = 0) {
    this.script = script || '';
    this.scriptLength = this.script.length;
    this.cleanScript = normalizeText(this.script);
    this.cleanLength = this.cleanScript.length;
    this.buildIndexMaps();

    this.currentPosition = this.toCleanIndex(startIndex);
    this.sessionStartTime = Date.now();
    this.lastSpeechTime = Date.now();
    this.baseSpeed = CONFIG.BASE_SPEED;
    this.lastTickTime = Date.now();
    this.calibrationConfidence = 0;
    this.lastAsrText = '';
    this.consecutiveSameCount = 0;
  }

  buildIndexMaps() {
    this.cleanToOriginal = [];
    this.originalToClean = new Array(this.scriptLength + 1);
    let cleanCount = 0;

    for (let i = 0; i < this.scriptLength; i++) {
      this.originalToClean[i] = cleanCount;
      if (CLEAN_REGEX.test(this.script[i])) {
        this.cleanToOriginal.push(i);
        cleanCount++;
      }
    }

    this.originalToClean[this.scriptLength] = cleanCount;
  }

  toCleanIndex(originalIndex) {
    const index = Math.max(0, Math.min(this.scriptLength, originalIndex || 0));
    return this.originalToClean[index] || 0;
  }

  toOriginalIndex(cleanIndex) {
    if (this.scriptLength === 0) return 0;
    if (cleanIndex <= 0) return 0;
    if (cleanIndex >= this.cleanToOriginal.length) return this.scriptLength - 1;
    return this.cleanToOriginal[cleanIndex] || 0;
  }

  getProgress() {
    if (this.scriptLength === 0) return 0;
    return this.toOriginalIndex(this.currentPosition) / this.scriptLength;
  }

  getMatchResult(position, matchedLen, confidence, matchType) {
    const cleanPosition = Math.max(0, Math.min(this.cleanLength, position + matchedLen));
    const originalIndex = this.toOriginalIndex(cleanPosition);

    return {
      progress: this.scriptLength === 0 ? 0 : originalIndex / this.scriptLength,
      cleanPosition,
      originalIndex,
      confidence,
      matchedLen,
      matchType
    };
  }

  getTimeBasedProgress() {
    const elapsed = (Date.now() - this.sessionStartTime) / 1000;
    const timeBasedChars = elapsed * this.baseSpeed;
    return Math.min(timeBasedChars / Math.max(1, this.cleanLength), 0.9);
  }

  // Backward-compatible API: return progress only.
  match(deltaText) {
    const result = this.matchDelta(deltaText);
    return result ? result.progress : null;
  }

  matchDelta(deltaText) {
    if (!deltaText) return null;

    const cleanDelta = normalizeText(deltaText);
    if (cleanDelta.length < CONFIG.MATCH_MIN_LENGTH) return null;

    if (this.lastAsrText && cleanDelta.length > 5) {
      const startOfScript = this.cleanScript.slice(0, Math.min(cleanDelta.length + 5, 50));
      const similarity = this.calculateSimilarity(cleanDelta, startOfScript);

      if (similarity > 0.7 && this.consecutiveSameCount > 0) {
        this.consecutiveSameCount++;
        return this.getMatchResult(this.currentPosition, 0, 1, 'reset');
      }
    }

    if (cleanDelta === this.lastAsrText) {
      this.consecutiveSameCount++;
    } else {
      this.consecutiveSameCount = 0;
      this.lastAsrText = cleanDelta;
    }

    const matchResult = this.findBestMatch(cleanDelta);
    if (!matchResult) return null;

    const { position, matchedLen, exact } = matchResult;
    const positionDiff = position - this.currentPosition;

    if (positionDiff < CONFIG.POSITION_DIFF_MIN || positionDiff > CONFIG.POSITION_DIFF_MAX) {
      return null;
    }

    const confidence = this.calculateConfidence(position, matchedLen, {
      textLength: cleanDelta.length,
      exact,
      mode: 'delta'
    });

    if (confidence < CONFIG.CONFIDENCE_THRESHOLD) return null;

    this.currentPosition = position + matchedLen;
    this.calibrationConfidence = confidence;
    this.lastSpeechTime = Date.now();
    return this.getMatchResult(position, matchedLen, confidence, 'delta');
  }

  matchContext(contextText) {
    if (!contextText) return null;

    const cleanContext = normalizeText(contextText);
    if (cleanContext.length < CONFIG.MATCH_MIN_LENGTH) return null;

    const text = cleanContext.slice(-(CONFIG.RECOVERY_TAIL_LENGTH || 50));
    const matchResult = this.findBestMatch(text, {
      before: CONFIG.RECOVERY_SEARCH_WINDOW_BEFORE,
      after: CONFIG.RECOVERY_SEARCH_WINDOW_AFTER
    });

    if (!matchResult) return null;

    const { position, matchedLen, exact } = matchResult;
    const positionDiff = position - this.currentPosition;

    if (
      positionDiff < CONFIG.RECOVERY_POSITION_DIFF_MIN ||
      positionDiff > CONFIG.RECOVERY_POSITION_DIFF_MAX
    ) {
      return null;
    }

    const confidence = this.calculateConfidence(position, matchedLen, {
      textLength: text.length,
      exact,
      mode: 'context'
    });

    if (confidence < CONFIG.CONFIDENCE_THRESHOLD) return null;

    this.currentPosition = position + matchedLen;
    this.calibrationConfidence = confidence;
    this.lastSpeechTime = Date.now();
    return this.getMatchResult(position, matchedLen, confidence, 'context');
  }

  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const len = Math.min(str1.length, str2.length);
    let matches = 0;

    for (let i = 0; i < len; i++) {
      if (str1[i] === str2[i]) matches++;
    }

    return matches / len;
  }

  findBestMatch(text, options = {}) {
    const scriptLen = this.cleanScript.length;
    if (!text || text.length > scriptLen) return null;

    const before = options.before === undefined ? CONFIG.SEARCH_WINDOW_BEFORE : options.before;
    const after = options.after === undefined ? CONFIG.SEARCH_WINDOW_AFTER : options.after;
    const searchStart = Math.max(0, this.currentPosition - before);
    const searchEnd = Math.min(scriptLen, this.currentPosition + after);
    const candidates = [];

    this.collectCandidates(candidates, text, text.length, searchStart, searchEnd, true);

    for (let len = Math.min(text.length, CONFIG.MATCH_MAX_LENGTH); len >= CONFIG.MATCH_MIN_LENGTH; len--) {
      if (len === text.length) continue;
      this.collectCandidates(candidates, text.slice(-len), len, searchStart, searchEnd, false);
    }

    if (!candidates.length) return null;

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  collectCandidates(candidates, sub, matchedLen, searchStart, searchEnd, exact) {
    if (!sub) return;

    let idx = this.cleanScript.indexOf(sub, searchStart);
    while (idx !== -1 && idx < searchEnd) {
      candidates.push({
        position: idx,
        matchedLen,
        exact,
        score: this.scoreCandidate(idx, matchedLen, exact)
      });
      idx = this.cleanScript.indexOf(sub, idx + 1);
    }
  }

  scoreCandidate(position, matchedLen, exact) {
    const diff = position - this.currentPosition;
    const distancePenalty = Math.min(Math.abs(diff) / 200, 1) * 0.35;
    const forwardBonus = diff >= 0 ? 0.18 : 0;
    const exactBonus = exact ? 0.18 : 0;
    const lengthScore = Math.min(matchedLen / CONFIG.MATCH_MAX_LENGTH, 1) * 0.45;

    return lengthScore + forwardBonus + exactBonus - distancePenalty;
  }

  calculateConfidence(position, matchedLen, options = {}) {
    let confidence = Math.min(matchedLen / 15, 1) * 0.5;
    const diff = position - this.currentPosition;

    if (diff >= -10 && diff <= 50) {
      confidence += (1 - Math.abs(diff) / 50) * 0.5;
    } else if (diff > 50 && diff <= 150) {
      confidence += 0.3 * (1 - (diff - 50) / 100);
    } else if (options.mode === 'context' && diff > 150 && diff <= 320) {
      confidence += 0.12 * (1 - (diff - 150) / 170);
    }

    if (options.exact && matchedLen === options.textLength) {
      confidence += 0.12;
    }

    if (options.mode === 'context') {
      confidence -= 0.08;
    }

    if (matchedLen <= 5 && diff > 80) {
      confidence -= 0.2;
    }

    return Math.max(0, Math.min(confidence, 1));
  }

  tick() {
    this.lastTickTime = Date.now();
    return null;
  }

  setPosition(originalIndex) {
    this.currentPosition = this.toCleanIndex(originalIndex);
    this.sessionStartTime = Date.now();
    this.lastSpeechTime = Date.now();
    this.lastTickTime = Date.now();
    this.calibrationConfidence = 0;
    this.lastAsrText = '';
    this.consecutiveSameCount = 0;
  }

  reset(startIndex = 0) {
    this.setPosition(startIndex);
  }
}

class AnchorTextMatcher extends SmartMatcher {
  constructor(fullScript, startIndex = 0) {
    super(fullScript, startIndex);
  }

  match(text) {
    return super.match(text);
  }
}

module.exports = { SmartMatcher, AnchorTextMatcher };
