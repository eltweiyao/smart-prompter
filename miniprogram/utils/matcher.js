/**
 * SmartMatcher - 智能语音跟随算法
 *
 * 核心思路：
 * 1. 识别推进为主 - 根据识别到的文字推进位置
 * 2. 匹配校准为辅 - 当匹配成功时微调进度
 * 3. 宽松匹配 + 位置验证
 */

const { normalizeText, CONFIG } = require('./helpers.js');

// 清洗文本正则
const CLEAN_REGEX = /[\u4e00-\u9fa5a-zA-Z0-9]/;

class SmartMatcher {
  constructor(script, startIndex = 0) {
    this.script = script;
    this.scriptLength = script.length;

    // 清洗后的脚本
    this.cleanScript = normalizeText(script);

    // 当前位置（清洗后的字符索引）
    this.currentPosition = this.toCleanIndex(startIndex);

    // 时间驱动进度
    this.sessionStartTime = Date.now();
    this.lastSpeechTime = Date.now();
    this.baseSpeed = CONFIG.BASE_SPEED;

    // 上次 tick 时间
    this.lastTickTime = Date.now();

    // 校准状态
    this.calibrationConfidence = 0;

    // ASR 重置检测
    this.lastAsrText = '';
    this.consecutiveSameCount = 0;
  }

  /**
   * 原始索引 -> 清洗后的索引
   */
  toCleanIndex(originalIndex) {
    let count = 0;
    for (let i = 0; i < originalIndex; i++) {
      if (CLEAN_REGEX.test(this.script[i])) {
        count++;
      }
    }
    return count;
  }

  /**
   * 清洗后的索引 -> 原始索引
   */
  toOriginalIndex(cleanIndex) {
    let cleanCount = 0;
    for (let i = 0; i < this.script.length; i++) {
      if (CLEAN_REGEX.test(this.script[i])) {
        cleanCount++;
        if (cleanCount >= cleanIndex) {
          return i;
        }
      }
    }
    return this.scriptLength - 1;
  }

  /**
   * 获取进度 (0-1)
   */
  getProgress() {
    if (this.scriptLength === 0) return 0;
    const originalIndex = this.toOriginalIndex(this.currentPosition);
    return originalIndex / this.scriptLength;
  }

  /**
   * 获取基于时间的进度（独立于识别）
   */
  getTimeBasedProgress() {
    const elapsed = (Date.now() - this.sessionStartTime) / 1000; // 秒
    const cleanLength = this.cleanScript.length;
    const timeBasedChars = elapsed * this.baseSpeed;

    // 时间进度受基础速度限制，最多到 90%
    const progress = Math.min(timeBasedChars / cleanLength, 0.9);
    return progress;
  }

  /**
   * 核心匹配 - 处理增量文本
   * @param {string} deltaText - 新增的识别文本
   * @returns {number|null} 进度值
   */
  match(deltaText) {
    if (!deltaText) {
      return null;
    }

    const cleanDelta = normalizeText(deltaText);

    if (cleanDelta.length < CONFIG.MATCH_MIN_LENGTH) {
      return null;
    }

    // 检测 ASR 重置
    if (this.lastAsrText && cleanDelta.length > 5) {
      const startOfScript = this.cleanScript.slice(0, Math.min(cleanDelta.length + 5, 50));
      const similarity = this.calculateSimilarity(cleanDelta, startOfScript);

      if (similarity > 0.7 && this.consecutiveSameCount > 0) {
        this.consecutiveSameCount++;
        return this.getProgress();
      }
    }

    // 更新 ASR 文本追踪
    if (cleanDelta === this.lastAsrText) {
      this.consecutiveSameCount++;
    } else {
      this.consecutiveSameCount = 0;
      this.lastAsrText = cleanDelta;
    }

    // 在校准窗口内搜索匹配
    const matchResult = this.findBestMatch(cleanDelta);

    if (!matchResult) {
      return null;
    }

    const { position, matchedLen } = matchResult;

    // 位置验证
    const positionDiff = position - this.currentPosition;

    if (positionDiff < CONFIG.POSITION_DIFF_MIN || positionDiff > CONFIG.POSITION_DIFF_MAX) {
      return null;
    }

    // 计算校准置信度
    const confidence = this.calculateConfidence(position, matchedLen);

    // 高置信度时校准
    if (confidence >= CONFIG.CONFIDENCE_THRESHOLD) {
      this.currentPosition = position + matchedLen;
      this.calibrationConfidence = confidence;
      this.lastSpeechTime = Date.now();
      return this.getProgress();
    }

    return null;
  }

  /**
   * 计算两个字符串的相似度（简单字符匹配）
   */
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const len = Math.min(str1.length, str2.length);
    let matches = 0;
    for (let i = 0; i < len; i++) {
      if (str1[i] === str2[i]) matches++;
    }
    return matches / len;
  }

  /**
   * 查找最佳匹配
   */
  findBestMatch(text) {
    const script = this.cleanScript;
    const scriptLen = script.length;

    if (text.length > scriptLen) return null;

    // 在当前位置附近搜索
    const searchStart = Math.max(0, this.currentPosition - CONFIG.SEARCH_WINDOW_BEFORE);
    const searchEnd = Math.min(scriptLen, this.currentPosition + CONFIG.SEARCH_WINDOW_AFTER);

    // 首先尝试精确匹配整个文本
    const exactIdx = script.indexOf(text, searchStart);
    if (exactIdx !== -1 && exactIdx < searchEnd) {
      return {
        position: exactIdx,
        matchedLen: text.length
      };
    }

    // 尝试部分匹配
    let bestPosition = -1;
    let bestMatchedLen = 0;

    for (let len = Math.min(text.length, CONFIG.MATCH_MAX_LENGTH); len >= CONFIG.MATCH_MIN_LENGTH; len--) {
      const sub = text.slice(-len);
      const idx = script.indexOf(sub, searchStart);

      if (idx !== -1 && idx < searchEnd) {
        bestPosition = idx;
        bestMatchedLen = len;
        break;
      }
    }

    if (bestPosition === -1) return null;

    return {
      position: bestPosition,
      matchedLen: bestMatchedLen
    };
  }

  /**
   * 计算校准置信度
   */
  calculateConfidence(position, matchedLen) {
    let confidence = 0;

    // 1. 匹配长度得分 (0-0.5)
    // 越长置信度越高
    confidence += Math.min(matchedLen / 15, 1) * 0.5;

    // 2. 位置合理性得分 (0-0.5)
    // 匹配位置应该在当前位置附近或之后
    const diff = position - this.currentPosition;
    if (diff >= -10 && diff <= 50) {
      // 匹配位置接近当前位置，置信度高
      confidence += (1 - Math.abs(diff) / 50) * 0.5;
    } else if (diff > 50 && diff <= 150) {
      // 匹配位置在当前位置之后，置信度中等
      confidence += 0.3 * (1 - (diff - 50) / 100);
    }

    return Math.min(confidence, 1);
  }

  /**
   * 定时检查 - 仅更新 lastTickTime，不自动推进
   * 推进完全依赖语音识别
   */
  tick() {
    this.lastTickTime = Date.now();
    return null;
  }

  /**
   * 重置
   */
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

// 兼容旧版本导出
class AnchorTextMatcher extends SmartMatcher {
  constructor(fullScript, startIndex = 0) {
    super(fullScript, startIndex);
  }

  match(text) {
    return super.match(text);
  }
}

module.exports = { SmartMatcher, AnchorTextMatcher };
