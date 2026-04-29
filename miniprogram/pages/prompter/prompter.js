const plugin = requirePlugin("wechat-si");
const manager = plugin.getRecordRecognitionManager();
const { SmartMatcher } = require('../../utils/matcher.js');
const { STORAGE_KEYS, CONFIG } = require('../../utils/helpers.js');

Page({
  data: {
    id: null,
    content: '',
    statusBarHeight: 20,
    bgColor: '#000000',
    fontColor: '#ffffff',
    fontSize: 40,
    lineHeight: 1.6,
    letterSpacing: 0,
    textAlign: 'center',
    baselinePercent: 50,
    focusEnabled: false,
    countdown: 0,
    countdownDuration: 0,
    mode: 'basic',
    wordsPerMinute: 180,
    isRunning: false,
    showSettings: false,
    isLandscape: false,
    uiHidden: false,
    offsetY: 0,
    transitionStyle: '',
    isRecording: false,
    recordMode: false,  // 录制模式开关
    devicePosition: 'front',
    recordStatus: 'ready',  // ready, recording, saving
    activeSettingsTab: 'display',
    cameraStyle: '',
    showGuide: false,
    smartStatusText: '',
    smartStatusType: 'idle',
    isDragging: false,
    recordElapsedText: '0:00',
  },

  contentHeight: 0,
  contentWidth: 0,
  viewportHeight: 0,
  matcher: null,
  lastTouchY: 0,
  uiHideTimer: null,
  lastRecognizedLength: 0,
  cameraContext: null,
  recordStopInProgress: false,
  recordSaveStarted: false,
  recordTimer: null,
  recordStartTime: 0,
  layoutTimer: null,
  resizeMeasureTimer: null,
  recognitionRestartTimer: null,
  recognitionRecoverFrames: 0,
  orientationTimer: null,
  followTickTimer: null,
  followAnchorOffset: 0,
  lastAsrActivityTime: 0,
  lastAsrCandidateTime: 0,
  lastFollowTickTime: 0,
  lastStableMatchTime: 0,
  lastStableOriginalIndex: 0,
  warmupStartOffset: 0,
  estimatedFollowSpeed: 0,
  smartSpeaking: false,
  smartFollowDebug: false,
  lastFollowDebugTime: 0,
  tempScriptKey: '',
  isUnloaded: false,

  closeGuide: function() {
    wx.setStorageSync(STORAGE_KEYS.GUIDE_SEEN, true);
    this.setData({ showGuide: false });
  },

  goBack: function() {
    wx.navigateBack();
  },

  onLoad: function(options) {
    this.isUnloaded = false;
    const sysInfo = wx.getSystemInfoSync();
    this.setData({
      statusBarHeight: sysInfo.statusBarHeight,
      isLandscape: sysInfo.windowWidth > sysInfo.windowHeight
    });

    // Load User Settings
    this.loadSettings();
    this.updateStatusBarColor(this.data.bgColor);

    if (options.tempScriptKey) {
      this.tempScriptKey = options.tempScriptKey;
      const content = wx.getStorageSync(options.tempScriptKey);
      this.setData({ content: content || '' });
    } else if (options.content) {
      const content = decodeURIComponent(options.content);
      this.setData({ content: content });
    } else if (options.id) {
      this.loadScript(options.id);
    }

    if (options.orientation) {
      this.orientationTimer = setTimeout(() => {
        this.orientationTimer = null;
        if (this.isUnloaded) return;
        if (options.orientation === 'auto') {
           wx.setPageOrientation({ orientation: 'auto' });
        } else {
           wx.setPageOrientation({ orientation: options.orientation });
        }
      }, 100);
    }

    if (options.isRecording === 'true') {
      this.setData({ isRecording: true, recordMode: true });
      this.initCamera();
    }
    if (!wx.getStorageSync(STORAGE_KEYS.GUIDE_SEEN)) {
      this.setData({ showGuide: true });
    }
    wx.setKeepScreenOn({ keepScreenOn: true });
  },

  onReady: function() {
    this.initLayoutLoop();
    this.resetUiAutoHide();
    // 监听窗口大小变化（横竖屏切换）
    const that = this;
    this.resizeHandler = function() {
      if (that.isUnloaded) return;
      const sysInfo = wx.getSystemInfoSync();
      that.setData({
        isLandscape: sysInfo.windowWidth > sysInfo.windowHeight
      }, () => {
        that.initLayoutLoop();
      });
      that.updateCameraView();
    };
    wx.onWindowResize(this.resizeHandler);
  },

  onShow: function() {
    // 每次显示时更新 camera 样式
    if (this.data.isRecording) {
      this.updateCameraView();
    }
  },

  initCamera: function() {
    wx.getSetting({
      success: res => {
        if (!res.authSetting['scope.camera'] || !res.authSetting['scope.record']) {
          wx.authorize({
            scope: 'scope.camera',
            success: () => {
              wx.authorize({
                scope: 'scope.record',
                success: () => {
                  this.cameraContext = wx.createCameraContext();
                },
                fail: () => {
                  wx.showToast({ title: '录像功能需要授权', icon: 'none' });
                  this.setData({ isRecording: false, recordMode: false });
                }
              })
            },
            fail: () => {
              wx.showToast({ title: '相机功能需要授权', icon: 'none' });
              this.setData({ isRecording: false, recordMode: false });
            }
          })
        } else {
          this.cameraContext = wx.createCameraContext();
        }
      }
    })
  },

  onUnload: function() {
    this.isUnloaded = true;
    this.stopAll();
    if (this.data.recordStatus === 'recording') {
      this.stopRecordAndSave();
    }
    if (this.resizeHandler && wx.offWindowResize) {
      wx.offWindowResize(this.resizeHandler);
      this.resizeHandler = null;
    }
    this.clearLayoutTimer();
    if (this.resizeMeasureTimer) {
      clearTimeout(this.resizeMeasureTimer);
      this.resizeMeasureTimer = null;
    }
    if (this.recognitionRestartTimer) {
      clearTimeout(this.recognitionRestartTimer);
      this.recognitionRestartTimer = null;
    }
    if (this.orientationTimer) {
      clearTimeout(this.orientationTimer);
      this.orientationTimer = null;
    }
    this.clearFollowTick();
    this.clearRecordTimer();
    if (this.tempScriptKey) {
      wx.removeStorageSync(this.tempScriptKey);
      this.tempScriptKey = '';
    }
    this.cancelUiAutoHide();
    wx.setPageOrientation({ orientation: 'portrait' });
    wx.setKeepScreenOn({ keepScreenOn: false });
  },

  cancelUiAutoHide: function() {
    if (this.uiHideTimer) {
      clearTimeout(this.uiHideTimer);
      this.uiHideTimer = null;
    }
    if (!this.isUnloaded && this.data.uiHidden) {
      this.setData({ uiHidden: false });
    }
  },

  onResize: function(res) {
    if (this.isUnloaded) return;
    const sysInfo = wx.getSystemInfoSync();
    this.setData({
      statusBarHeight: sysInfo.statusBarHeight,
      isLandscape: sysInfo.windowWidth > sysInfo.windowHeight
    });
    if (this.resizeMeasureTimer) {
      clearTimeout(this.resizeMeasureTimer);
    }
    this.resizeMeasureTimer = setTimeout(() => {
      this.resizeMeasureTimer = null;
      if (this.isUnloaded) return;
      this.measureLayout();
    }, 300);
  },

  initLayoutLoop: function() {
    this.clearLayoutTimer();
    this.measureLayout((layout) => {
      if (this.isUnloaded) return;
      if (!layout || layout.contentHeight <= 0) {
        this.layoutTimer = setTimeout(() => {
          this.layoutTimer = null;
          this.initLayoutLoop();
        }, 500);
      }
    });
  },

  clearLayoutTimer: function() {
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }
  },

  measureLayout: function(callback) {
    const query = wx.createSelectorQuery().in(this);
    query.select('.text-content').fields({
      size: true,
      computedStyle: ['paddingLeft', 'paddingRight']
    });
    query.select('.prompter-viewport').boundingClientRect();
    query.exec((res) => {
      if (res && res[0] && res[1]) {
        const contentRect = res[0];
        const paddingLeft = this.parsePx(contentRect.paddingLeft);
        const paddingRight = this.parsePx(contentRect.paddingRight);
        this.contentHeight = res[0].height;
        this.contentWidth = Math.max(1, (contentRect.width || 0) - paddingLeft - paddingRight);
        this.viewportHeight = res[1].height;
        if (callback) callback({ contentHeight: this.contentHeight, viewportHeight: this.viewportHeight });
      } else if (callback) {
        callback(null);
      }
    });
  },

  parsePx: function(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  },

  getEstimatedCharsPerLine: function() {
    const fontSize = Math.max(1, this.data.fontSize);
    const letterSpacing = Math.max(0, this.data.letterSpacing || 0);
    const charWidth = fontSize + letterSpacing;
    return Math.max(1, Math.floor((this.contentWidth || fontSize) / charWidth));
  },

  getTextUnitLength: function(text) {
    let units = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char)) {
        units += 1;
      } else if (/\s/.test(char)) {
        units += 0.35;
      } else {
        units += 0.55;
      }
    }
    return units;
  },

  getEstimatedRowsForLines: function(lines, charsPerLine, partialLastLine) {
    let rows = 0;

    for (let i = 0; i < lines.length; i++) {
      const units = this.getTextUnitLength(lines[i]);
      const isLastLine = i === lines.length - 1;

      if (partialLastLine && isLastLine) {
        rows += units / charsPerLine;
      } else {
        rows += Math.max(1, Math.ceil(units / charsPerLine));
      }
    }

    return rows;
  },

  getSmartFollowRowScale: function(charsPerLine) {
    const content = this.data.content || '';
    const lineHeightPx = Math.max(1, this.data.fontSize * this.data.lineHeight);
    const actualRows = Math.max(1, Math.round(this.contentHeight / lineHeightPx));
    const estimatedRows = Math.max(1, this.getEstimatedRowsForLines(content.split('\n'), charsPerLine, false));
    return actualRows / estimatedRows;
  },

  getSmartFollowRowsByIndex: function(originalIndex) {
    const content = this.data.content || '';
    if (!content) return 0;

    const targetIndex = Math.max(0, Math.min(content.length, originalIndex || 0));
    const charsPerLine = this.getEstimatedCharsPerLine();
    const rows = this.getEstimatedRowsForLines(content.slice(0, targetIndex).split('\n'), charsPerLine, true);
    return rows * this.getSmartFollowRowScale(charsPerLine);
  },

  getSmartFollowRowsByText: function(progress) {
    const content = this.data.content || '';
    const targetIndex = Math.floor(content.length * progress);
    return this.getSmartFollowRowsByIndex(targetIndex);
  },

  getSmartFollowLeadRows: function(charsPerLine) {
    if (this.data.isLandscape) return 0.2;
    if (charsPerLine <= 8) return 0.45;
    if (charsPerLine <= 12) return 0.3;
    if (charsPerLine <= 18) return 0.2;
    return 0.12;
  },

  getSmartFollowSnapThreshold: function(charsPerLine) {
    if (this.data.isLandscape && charsPerLine >= 18) return 0.45;
    return 0.65;
  },

  getSmartFollowOffset: function(matchInfo) {
    const lineHeightPx = Math.max(1, this.data.fontSize * this.data.lineHeight);
    const charsPerLine = this.getEstimatedCharsPerLine();
    const originalIndex = typeof matchInfo === 'number'
      ? Math.floor((this.data.content || '').length * matchInfo)
      : matchInfo.originalIndex;
    const rawDistance = this.getSmartFollowRowsByIndex(originalIndex) * lineHeightPx;
    const leadRows = this.getSmartFollowLeadRows(charsPerLine);
    const snappedDistance = rawDistance + lineHeightPx * leadRows;
    const maxDistance = Math.max(0, this.contentHeight - lineHeightPx);
    return -Math.min(snappedDistance, maxDistance);
  },

  updateSmartFollowOffset: function(matchInfo) {
    const targetOffset = this.getSmartFollowOffset(matchInfo);
    this.updateFollowAnchor(targetOffset, matchInfo);
  },

  updateFollowAnchor: function(targetOffset, matchInfo) {
    if (!Number.isFinite(targetOffset) || targetOffset >= this.followAnchorOffset) {
      this.logSmartFollowDebug('anchor-skip', {
        targetOffset,
        followAnchorOffset: this.followAnchorOffset,
        matchInfo
      });
      return;
    }

    const now = Date.now();
    const previousIndex = this.lastStableOriginalIndex || 0;
    const previousTime = this.lastStableMatchTime || 0;

    if (previousTime && matchInfo && matchInfo.originalIndex > previousIndex) {
      const elapsed = Math.max(1, now - previousTime);
      const indexDelta = matchInfo.originalIndex - previousIndex;
      const rowsDelta = this.getSmartFollowRowsByIndex(matchInfo.originalIndex) - this.getSmartFollowRowsByIndex(previousIndex);
      const lineHeightPx = Math.max(1, this.data.fontSize * this.data.lineHeight);
      const speed = Math.max(0, rowsDelta * lineHeightPx / elapsed);

      if (speed > 0) {
        this.estimatedFollowSpeed = this.estimatedFollowSpeed
          ? this.estimatedFollowSpeed * 0.7 + speed * 0.3
          : speed;
      }

      if (indexDelta > 0) {
        this.lastStableOriginalIndex = matchInfo.originalIndex;
      }
    } else if (matchInfo) {
      this.lastStableOriginalIndex = matchInfo.originalIndex;
    }

    this.lastStableMatchTime = now;
    this.followAnchorOffset = targetOffset;
    this.logSmartFollowDebug('anchor-update', {
      targetOffset,
      previousIndex,
      newIndex: matchInfo ? matchInfo.originalIndex : null,
      confidence: matchInfo ? matchInfo.confidence : null,
      matchType: matchInfo ? matchInfo.matchType : null,
      estimatedFollowSpeed: Number(this.estimatedFollowSpeed.toFixed(4))
    });
  },

  markSmartSpeechActivity: function(hasFreshSpeech, options) {
    if (!hasFreshSpeech) {
      this.logSmartFollowDebug('speech-no-fresh-delta', {
        smartSpeaking: this.smartSpeaking,
        lastAsrAge: this.lastAsrActivityTime ? Date.now() - this.lastAsrActivityTime : null
      }, true);
      return;
    }

    const info = options || {};
    const now = Date.now();
    const hadRecentActivity = !this.lastAsrActivityTime ||
      now - this.lastAsrActivityTime <= CONFIG.SMART_SPEECH_RESUME_GRACE_MS;
    const hasCandidate = this.lastAsrCandidateTime &&
      now - this.lastAsrCandidateTime <= CONFIG.SMART_SPEECH_RESUME_GRACE_MS;
    const shouldForceActive = !!info.hasMatch ||
      (hadRecentActivity && info.deltaLength >= CONFIG.SMART_MIN_ACTIVE_DELTA_LENGTH);

    if (shouldForceActive || this.smartSpeaking || hadRecentActivity || hasCandidate) {
      this.lastAsrActivityTime = now;
      this.lastAsrCandidateTime = 0;
      this.smartSpeaking = true;
      this.logSmartFollowDebug('speech-active', {
        forceActive: shouldForceActive,
        deltaLength: info.deltaLength,
        hasMatch: !!info.hasMatch,
        hadRecentActivity,
        hasCandidate,
        lastAsrActivityTime: this.lastAsrActivityTime
      });
      return;
    }

    this.lastAsrCandidateTime = now;
    this.logSmartFollowDebug('speech-candidate', {
      reason: 'first fresh delta after a long pause',
      deltaLength: info.deltaLength,
      hasMatch: !!info.hasMatch,
      lastAsrAge: this.lastAsrActivityTime ? now - this.lastAsrActivityTime : null,
      resumeGraceMs: CONFIG.SMART_SPEECH_RESUME_GRACE_MS
    });
  },

  isSmartSpeakingActive: function(now) {
    return this.smartSpeaking && now - this.lastAsrActivityTime <= CONFIG.SMART_SILENCE_HOLD_MS;
  },

  getDefaultFollowSpeed: function() {
    const lineHeightPx = Math.max(1, this.data.fontSize * this.data.lineHeight);
    const charsPerLine = this.getEstimatedCharsPerLine();
    const rowsPerSecond = Math.max(0.2, this.data.wordsPerMinute / Math.max(1, charsPerLine) / 60);
    return rowsPerSecond * lineHeightPx / 1000;
  },

  getPredictedFollowTarget: function(now, currentOffset) {
    const lastMatchAge = this.lastStableMatchTime ? now - this.lastStableMatchTime : Infinity;

    if (!this.lastStableMatchTime && this.lastAsrActivityTime) {
      const lineHeightPx = Math.max(1, this.data.fontSize * this.data.lineHeight);
      const speed = this.getDefaultFollowSpeed();
      const elapsed = Math.max(0, now - this.lastAsrActivityTime);
      const maxAhead = lineHeightPx * CONFIG.SMART_WARMUP_MAX_AHEAD_ROWS;
      const warmupDistance = Math.min(maxAhead, speed * elapsed);
      return Math.min(currentOffset, this.warmupStartOffset - warmupDistance);
    }

    if (
      !this.estimatedFollowSpeed ||
      lastMatchAge > CONFIG.SMART_PREDICT_MATCH_WINDOW_MS
    ) {
      return Math.min(currentOffset, this.followAnchorOffset);
    }

    const lineHeightPx = Math.max(1, this.data.fontSize * this.data.lineHeight);
    const maxAhead = lineHeightPx * CONFIG.SMART_PREDICT_MAX_AHEAD_ROWS;
    const predictedAhead = Math.min(maxAhead, this.estimatedFollowSpeed * lastMatchAge);
    const predictedOffset = this.followAnchorOffset - predictedAhead;
    return Math.min(currentOffset, predictedOffset);
  },

  startFollowTick: function() {
    this.clearFollowTick();
    this.lastFollowTickTime = Date.now();
    this.followTickTimer = setInterval(() => this.runFollowTick(), CONFIG.SMART_FOLLOW_TICK_MS);
  },

  clearFollowTick: function() {
    if (this.followTickTimer) {
      clearInterval(this.followTickTimer);
      this.followTickTimer = null;
    }
  },

  logSmartFollowDebug: function(event, payload, throttle) {
    if (!this.smartFollowDebug) return;
    const now = Date.now();
    if (throttle && now - this.lastFollowDebugTime < 500) return;
    this.lastFollowDebugTime = now;
    console.log(`[smart-follow ${event}]`, payload || {});
  },

  runFollowTick: function() {
    if (this.isUnloaded || !this.data.isRunning || this.data.mode !== 'smart') return;

    const now = Date.now();
    const currentOffset = this.data.offsetY;
    const lineHeightPx = Math.max(1, this.data.fontSize * this.data.lineHeight);
    const speaking = this.isSmartSpeakingActive(now);

    if (!speaking) {
      if (this.smartSpeaking) {
        this.logSmartFollowDebug('pause', {
          reason: 'silence timeout',
          now,
          lastAsrActivityTime: this.lastAsrActivityTime,
          silenceMs: this.lastAsrActivityTime ? now - this.lastAsrActivityTime : null,
          silenceHoldMs: CONFIG.SMART_SILENCE_HOLD_MS,
          currentOffset,
          followAnchorOffset: this.followAnchorOffset
        });
        this.smartSpeaking = false;
        this.setData({
          smartStatusText: '已暂停',
          smartStatusType: 'idle',
          transitionStyle: 'none'
        });
      }
      this.lastFollowTickTime = now;
      return;
    }

    const targetOffset = this.getPredictedFollowTarget(now, currentOffset);
    if (targetOffset >= currentOffset) {
      this.logSmartFollowDebug('tick-hold', {
        reason: 'target is not ahead',
        currentOffset,
        targetOffset,
        followAnchorOffset: this.followAnchorOffset,
        lastMatchAge: this.lastStableMatchTime ? now - this.lastStableMatchTime : null,
        asrIdleMs: this.lastAsrActivityTime ? now - this.lastAsrActivityTime : null
      }, true);
      this.lastFollowTickTime = now;
      this.setData({
        smartStatusText: '跟随中',
        smartStatusType: 'listening'
      });
      return;
    }

    const distance = currentOffset - targetOffset;
    const maxStepRows = this.data.isLandscape ? 0.28 : 0.2;
    const maxStep = lineHeightPx * maxStepRows;
    const minStep = Math.min(distance, lineHeightPx * 0.035);
    const step = Math.min(distance, Math.max(minStep, distance * 0.22, maxStep * 0.35), maxStep);
    this.logSmartFollowDebug('tick-move', {
      currentOffset,
      targetOffset,
      followAnchorOffset: this.followAnchorOffset,
      distance: Number(distance.toFixed(2)),
      step: Number(step.toFixed(2)),
      maxStep: Number(maxStep.toFixed(2)),
      lastMatchAge: this.lastStableMatchTime ? now - this.lastStableMatchTime : null,
      asrIdleMs: this.lastAsrActivityTime ? now - this.lastAsrActivityTime : null,
      speaking
    }, true);

    this.lastFollowTickTime = now;
    this.setData({
      offsetY: currentOffset - step,
      transitionStyle: `transform ${CONFIG.SMART_FOLLOW_TICK_MS / 1000}s linear`,
      smartStatusText: '跟随中',
      smartStatusType: 'listening'
    });
  },

  loadScript: function(id) {
    const scripts = wx.getStorageSync(STORAGE_KEYS.SCRIPTS) || [];
    const script = scripts.find(s => s.id === id);
    if (script) {
      this.setData({ content: script.content }, () => this.initLayoutLoop());
    }
  },

  startBasicScroll: function() {
    if (this.data.isRunning) return;

    this.measureLayout((layout) => {
      if (!layout || layout.contentHeight <= 0) {
        wx.showToast({ title: '台本未就绪', icon: 'none' });
        return;
      }

      const duration = this.data.countdownDuration;
      if (duration <= 0) {
        this.runBasicScrollAnimation();
        return;
      }

      this.setData({ countdown: duration });
      this.countdownTimer = setInterval(() => {
        if (this.data.countdown > 1) {
          this.setData({ countdown: this.data.countdown - 1 });
        } else {
          clearInterval(this.countdownTimer);
          this.countdownTimer = null;
          this.setData({ countdown: 0 });
          this.runBasicScrollAnimation();
        }
      }, 1000);
    });
  },

  runBasicScrollAnimation: function() {
    const currentOffset = this.data.offsetY;
    const targetOffset = -this.contentHeight;
    const distance = Math.abs(targetOffset - currentOffset);
    if (distance <= 0) return;

    const wordCount = (this.data.content.match(/[\u4e00-\u9fa5]|\b\w+\b/g) || []).length || 1;
    const duration = (wordCount / this.data.wordsPerMinute) * 60 * (distance / (this.contentHeight || 1));

    this.setData({
      isRunning: true,
      transitionStyle: `transform ${duration}s linear`,
      offsetY: targetOffset
    });
  },

  /**
   * 启动智能语音跟随
   */
  startSmartFollow: function() {
    if (this.data.isRunning) return;

    this.measureLayout((layout) => {
      if (this.isUnloaded || this.data.isRunning) return;
      if (!layout || layout.contentHeight <= 0) {
        wx.showToast({ title: '台本未就绪', icon: 'none' });
        return;
      }

      this.setData({
        isRunning: true,
        smartStatusText: '聆听中',
        smartStatusType: 'listening'
      });

      // 初始化匹配器
      const currentProgress = Math.abs(this.data.offsetY) / this.contentHeight;
      const startIndex = Math.floor(this.data.content.length * currentProgress);

      this.matcher = new SmartMatcher(this.data.content, startIndex);
      this.lastRecognizedLength = 0;
      this.recognitionRecoverFrames = 0;
      this.followAnchorOffset = this.data.offsetY;
      this.lastAsrActivityTime = 0;
      this.lastAsrCandidateTime = 0;
      this.lastStableMatchTime = 0;
      this.lastStableOriginalIndex = startIndex;
      this.warmupStartOffset = this.data.offsetY;
      this.estimatedFollowSpeed = 0;
      this.smartSpeaking = false;
      this.startFollowTick();

      // 注册语音识别回调
      manager.onRecognize = (res) => {
        if (this.isUnloaded) return;
        const text = res.result || '';
        const previousLength = this.lastRecognizedLength;
        const isResetText = text.length < previousLength;
        const delta = !isResetText ? text.slice(previousLength) : '';
        this.lastRecognizedLength = text.length;
        const hasFreshSpeech = delta.length > 0;
        let matchInfo = null;
        let shouldRecover = false;

        if (text && this.matcher) {
          matchInfo = delta ? this.matcher.matchDelta(delta) : null;
          shouldRecover = isResetText || this.recognitionRecoverFrames > 0 || matchInfo === null;

          if (shouldRecover) {
            const contextMatch = this.matcher.matchContext(text);
            if (contextMatch) {
              matchInfo = contextMatch;
            }
          }

          if (this.recognitionRecoverFrames > 0) {
            this.recognitionRecoverFrames--;
          }

          this.logSmartFollowDebug('match', {
            shouldRecover,
            matchType: matchInfo ? matchInfo.matchType : null,
            confidence: matchInfo ? Number(matchInfo.confidence.toFixed(3)) : null,
            matchedLen: matchInfo ? matchInfo.matchedLen : null,
            originalIndex: matchInfo ? matchInfo.originalIndex : null,
            progress: matchInfo ? Number(matchInfo.progress.toFixed(4)) : null
          });

          if (matchInfo !== null) {
            this.updateSmartFollowOffset(matchInfo);
          }
        }

        this.markSmartSpeechActivity(hasFreshSpeech, {
          deltaLength: delta.length,
          hasMatch: !!matchInfo
        });
        this.logSmartFollowDebug('recognize', {
          textLength: text.length,
          previousLength,
          deltaLength: delta.length,
          isResetText,
          recoverFrames: this.recognitionRecoverFrames,
          smartSpeaking: this.smartSpeaking,
          textTail: text.slice(-18),
          delta
        });
      };

      manager.onStop = (res) => {
        if (!this.isUnloaded && this.data.isRunning && this.data.mode === 'smart') {
          this.logSmartFollowDebug('recognition-stop', {
            lastRecognizedLength: this.lastRecognizedLength,
            recoverFrames: CONFIG.RECOVERY_FRAME_COUNT,
            res
          });
          this.lastRecognizedLength = 0;
          this.recognitionRecoverFrames = CONFIG.RECOVERY_FRAME_COUNT;
          this.smartSpeaking = false;
          this.setData({
            smartStatusText: '已暂停',
            smartStatusType: 'idle',
            transitionStyle: 'none'
          });
          manager.start({ duration: 60000, lang: "zh_CN" });
        }
      };

      manager.onError = (res) => {
        if (this.data.isRunning && this.data.mode === 'smart') {
          this.logSmartFollowDebug('recognition-error', { res });
          if (this.recognitionRestartTimer) {
            clearTimeout(this.recognitionRestartTimer);
          }
          this.recognitionRestartTimer = setTimeout(() => {
            this.recognitionRestartTimer = null;
            if (!this.isUnloaded && this.data.isRunning && this.data.mode === 'smart') {
              this.lastRecognizedLength = 0;
              this.recognitionRecoverFrames = CONFIG.RECOVERY_FRAME_COUNT;
              this.smartSpeaking = false;
              this.setData({
                smartStatusText: '已暂停',
                smartStatusType: 'idle',
                transitionStyle: 'none'
              });
              manager.start({ duration: 60000, lang: "zh_CN" });
            }
          }, 1000);
        }
      };

      manager.start({ duration: 60000, lang: "zh_CN" });
    });
  },

  stopAll: function() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (!this.data.isRunning && this.data.countdown === 0) {
      if (!this.isUnloaded) {
        this.setData({ isRunning: false, countdown: 0 });
      }
      return;
    }
    if (this.data.mode === 'basic' && !this.isUnloaded) {
      this.freezeBasicScroll();
    } else {
      this.stopSmartFollow();
    }
    if (!this.isUnloaded) {
      this.setData({ isRunning: false, countdown: 0 });
    }
  },

  freezeBasicScroll: function() {
    if (this.isUnloaded) return;
    wx.createSelectorQuery().in(this).select('.prompter-content').fields({ computedStyle: ['transform'] }).exec((res) => {
      if (this.isUnloaded) return;
      if (!res[0]) return;
      const matrix = res[0].transform;
      let currentY = this.data.offsetY;
      if (matrix && matrix !== 'none') {
        const values = matrix.split('(')[1].split(')')[0].split(',');
        if (values.length === 6) currentY = parseFloat(values[5]);
      }
      this.setData({ isRunning: false, transitionStyle: 'none', offsetY: currentY });
    });
  },

  stopSmartFollow: function() {
    this.clearFollowTick();
    this.smartSpeaking = false;
    this.followAnchorOffset = this.data.offsetY;
    this.lastAsrCandidateTime = 0;
    this.estimatedFollowSpeed = 0;

    if (!this.isUnloaded) {
      this.setData({
        isRunning: false,
        smartStatusText: '',
        smartStatusType: 'idle',
        transitionStyle: 'none'
      });
    }

    if (this.recognitionRestartTimer) {
      clearTimeout(this.recognitionRestartTimer);
      this.recognitionRestartTimer = null;
    }

    try {
      manager.stop();
    } catch (e) {}

    // 注意：不再 reset matcher，保持当前位置
    // if (this.matcher) {
    //   this.matcher.reset();
    // }
  },

  onScreenTap: function() {
    if (this.data.showSettings) {
      this.setData({ showSettings: false });
      return;
    }
    if (this.data.isRunning) this.stopAll();
    this.resetUiAutoHide();
  },

  onTouchStart: function(e) {
    if (this.data.isRunning) {
      this.wasRunning = true;
      if (this.data.mode === 'basic') this.freezeBasicScroll();
    }
    this.lastTouchY = e.touches[0].clientY;
    this.isScrolling = false;
    this.setData({ isDragging: true });
  },

  onTouchMove: function(e) {
    this.isScrolling = true;
    const delta = e.touches[0].clientY - this.lastTouchY;
    this.lastTouchY = e.touches[0].clientY;
    this.setData({ offsetY: this.data.offsetY + delta, transitionStyle: 'none' });
  },

  onTouchEnd: function() {
    this.setData({ isDragging: false });
    if (this.wasRunning && this.data.mode === 'basic') {
      this.runBasicScrollAnimation();
    }
    this.wasRunning = false;
    // 手动滑动后重置匹配器位置
    if (this.isScrolling && this.matcher) {
      const currentProgress = Math.abs(this.data.offsetY) / this.contentHeight;
      const startIndex = Math.floor(this.data.content.length * currentProgress);
      this.matcher.setPosition(startIndex);
      this.followAnchorOffset = this.data.offsetY;
      this.lastStableOriginalIndex = startIndex;
      this.lastStableMatchTime = Date.now();
      this.warmupStartOffset = this.data.offsetY;
      this.estimatedFollowSpeed = 0;
    }
  },

  // --- Helpers & UI ---
  switchSettingsTab: function(e) {
    this.setData({ activeSettingsTab: e.currentTarget.dataset.tab });
  },

  normalizeSettingNumber: function(value, precision, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const factor = Math.pow(10, precision);
    return Math.round(number * factor) / factor;
  },

  normalizeSettings: function(settings) {
    return {
      ...settings,
      fontSize: this.normalizeSettingNumber(settings.fontSize, 0, this.data.fontSize),
      lineHeight: this.normalizeSettingNumber(settings.lineHeight, 1, this.data.lineHeight),
      letterSpacing: this.normalizeSettingNumber(settings.letterSpacing, 0, this.data.letterSpacing),
      baselinePercent: this.normalizeSettingNumber(settings.baselinePercent, 0, this.data.baselinePercent),
      wordsPerMinute: this.normalizeSettingNumber(settings.wordsPerMinute, 0, this.data.wordsPerMinute),
      countdownDuration: this.normalizeSettingNumber(settings.countdownDuration, 0, this.data.countdownDuration)
    };
  },

  onFontSizeChange: function(e) {
    const fontSize = this.normalizeSettingNumber(e.detail.value, 0, this.data.fontSize);
    this.setData({ fontSize }, () => this.initLayoutLoop());
    this.saveSettings();
  },

  onLineHeightChange: function(e) {
    const lineHeight = this.normalizeSettingNumber(e.detail.value, 1, this.data.lineHeight);
    this.setData({ lineHeight }, () => this.initLayoutLoop());
    this.saveSettings();
  },

  onLetterSpacingChange: function(e) {
    const letterSpacing = this.normalizeSettingNumber(e.detail.value, 0, this.data.letterSpacing);
    this.setData({ letterSpacing }, () => this.initLayoutLoop());
    this.saveSettings();
  },

  onTextAlignChange: function(e) {
    this.setData({ textAlign: e.currentTarget.dataset.align }, () => this.initLayoutLoop());
    this.saveSettings();
  },

  onWpmChange: function(e) {
    const wordsPerMinute = this.normalizeSettingNumber(e.detail.value, 0, this.data.wordsPerMinute);
    this.setData({ wordsPerMinute });
    this.saveSettings();
  },

  setSpeedPreset: function(e) {
    this.setData({ wordsPerMinute: Number(e.currentTarget.dataset.wpm) });
    this.saveSettings();
  },

  onCountdownDurationChange: function(e) {
    const countdownDuration = this.normalizeSettingNumber(e.detail.value, 0, this.data.countdownDuration);
    this.setData({ countdownDuration });
    this.saveSettings();
  },

  setFontColor: function(e) {
    this.setData({ fontColor: e.currentTarget.dataset.color.toLowerCase() });
    this.saveSettings();
  },

  setBgColor: function(e) {
    const color = e.currentTarget.dataset.color.toLowerCase();
    this.setData({ bgColor: color });
    this.updateStatusBarColor(color);
    this.saveSettings();
  },

  onBaselineChange: function(e) {
    const baselinePercent = this.normalizeSettingNumber(e.detail.value, 0, this.data.baselinePercent);
    this.setData({ baselinePercent });
    this.saveSettings();
  },

  onFocusToggle: function(e) {
    this.setData({ focusEnabled: e.detail.value });
    this.saveSettings();
  },

  loadSettings: function() {
    const s = wx.getStorageSync(STORAGE_KEYS.SETTINGS);
    if (s) {
      if (s.fontColor) s.fontColor = s.fontColor.toLowerCase();
      if (s.bgColor) s.bgColor = s.bgColor.toLowerCase();
      this.setData(this.normalizeSettings(s));
    }
  },

  saveSettings: function() {
    const d = this.normalizeSettings(this.data);
    const s = {
      fontSize: d.fontSize,
      lineHeight: d.lineHeight,
      letterSpacing: d.letterSpacing,
      textAlign: d.textAlign,
      baselinePercent: d.baselinePercent,
      focusEnabled: d.focusEnabled,
      wordsPerMinute: d.wordsPerMinute,
      countdownDuration: d.countdownDuration,
      fontColor: d.fontColor,
      bgColor: d.bgColor
    };
    wx.setStorageSync(STORAGE_KEYS.SETTINGS, s);
  },
  updateStatusBarColor: function(c) {
    wx.setNavigationBarColor({
      frontColor: c === '#ffffff' ? '#000000' : '#ffffff',
      backgroundColor: c === '#00b140' ? '#00b140' : '#000000'
    });
  },

  updateCameraView: function() {
    const sysInfo = wx.getSystemInfoSync();
    let cameraStyle = '';

    if (sysInfo.windowWidth > sysInfo.windowHeight) { // Landscape
        const targetAspectRatio = sysInfo.screenWidth / sysInfo.screenHeight;

        const landscapeHeight = sysInfo.windowHeight;
        const newWidth = landscapeHeight * targetAspectRatio;
        const widthOffset = (sysInfo.windowWidth - newWidth) / 2;

        cameraStyle = `width: ${newWidth}px; height: ${landscapeHeight}px; left: ${widthOffset}px; top: 0;`;

    } else { // Portrait
        cameraStyle = 'width: 100%; height: 100%; top: 0; left: 0;';
    }
    this.setData({ cameraStyle: cameraStyle });
  },

  toggleSettings: function() {
    this.setData({ showSettings: !this.data.showSettings });
  },

  switchMode: function(e) {
    this.stopAll();
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  resetUiAutoHide: function() {
    if (this.uiHideTimer) clearTimeout(this.uiHideTimer);
    if (this.isUnloaded) return;
    this.setData({ uiHidden: false });
    if (!this.data.isRunning && this.data.countdown === 0 && !this.data.showSettings) {
      this.uiHideTimer = setTimeout(() => {
        this.uiHideTimer = null;
        if (!this.isUnloaded) {
          this.setData({ uiHidden: true });
        }
      }, 5000);
    }
  },

  // --- 录制相关 ---

  formatRecordElapsed: function(seconds) {
    const safeSeconds = Math.max(0, Math.min(CONFIG.CAMERA_RECORD_MAX_DURATION, Math.floor(seconds || 0)));
    const minutes = Math.floor(safeSeconds / 60);
    const restSeconds = safeSeconds % 60;
    return `${minutes}:${restSeconds.toString().padStart(2, '0')}`;
  },

  updateRecordElapsed: function() {
    if (!this.recordStartTime) {
      this.setData({ recordElapsedText: '0:00' });
      return;
    }

    const elapsed = Math.floor((Date.now() - this.recordStartTime) / 1000);
    this.setData({ recordElapsedText: this.formatRecordElapsed(elapsed) });
  },

  startRecordTimer: function() {
    this.clearRecordTimer();
    this.recordStartTime = Date.now();
    this.setData({ recordElapsedText: '0:00' });
    this.recordTimer = setInterval(() => {
      this.updateRecordElapsed();
    }, 1000);
  },

  clearRecordTimer: function() {
    if (this.recordTimer) {
      clearInterval(this.recordTimer);
      this.recordTimer = null;
    }
  },

  stopRecordTimer: function() {
    this.updateRecordElapsed();
    this.clearRecordTimer();
    this.recordStartTime = 0;
  },

  toggleRecord: function() {
    if (!this.data.isRecording) return;
    switch(this.data.recordStatus) {
      case 'ready':
        this.startRecord();
        break;
      case 'recording':
        // API does not support pause/resume, so we stop.
        this.stopRecordAndSave();
        break;
      case 'saving':
        wx.showToast({ title: '正在保存...', icon: 'none' });
        break;
    }
  },

  startRecord: function() {
    if (!this.cameraContext) {
      wx.showToast({ title: '相机未就绪', icon: 'none' });
      return;
    }
    if (this.recordStopInProgress) return;
    this.recordSaveStarted = false;

    this.cameraContext.startRecord({
      timeout: CONFIG.CAMERA_RECORD_MAX_DURATION,
      success: () => {
        if (this.isUnloaded) return;
        this.recordStopInProgress = false;
        this.recordSaveStarted = false;
        this.setData({
          recordStatus: 'recording',
          recordElapsedText: '0:00'
        });
        this.startRecordTimer();
        wx.showToast({ title: '开始录制', icon: 'none' });
      },
      timeoutCallback: (res) => {
        this.stopRecordTimer();
        this.handleRecordFinished(res, {
          toastTitle: '录制已达时长上限',
          callback: null
        });
      },
      fail: (err) => {
        this.recordStopInProgress = false;
        this.recordSaveStarted = false;
        if (!this.isUnloaded) {
          this.setData({
            recordStatus: 'ready',
            recordElapsedText: '0:00'
          });
        }
        console.warn('[record start fail]', err);
        wx.showToast({ title: '录制失败', icon: 'error' });
      }
    });
  },

  stopRecordAndSave: function(callback) {
    if (!this.cameraContext) {
      if(callback) callback();
      return;
    }
    if (this.recordStopInProgress) {
      if(callback) callback();
      return;
    }
    if (this.data.recordStatus !== 'recording') {
      if(callback) callback();
      return;
    }
    this.recordStopInProgress = true;
    this.stopRecordTimer();
    if (!this.isUnloaded) {
      this.setData({ recordStatus: 'saving' });
    }

    this.cameraContext.stopRecord({
      success: (res) => {
        this.handleRecordFinished(res, { callback });
      },
      fail: (err) => {
        this.recordStopInProgress = false;
        if (!this.isUnloaded) {
          this.setData({
            recordStatus: 'ready',
            recordElapsedText: '0:00'
          });
        }
        console.warn('[record stop fail]', err);
        wx.showToast({ title: '结束录制失败', icon: 'error' });
        if(callback) callback();
      }
    });
  },

  handleRecordFinished: function(res, options = {}) {
    if (this.recordSaveStarted) {
      if (options.callback) options.callback();
      return;
    }
    this.recordStopInProgress = true;
    this.recordSaveStarted = true;
    this.stopRecordTimer();

    const tempVideoPath = res && res.tempVideoPath;
    if (!tempVideoPath) {
      this.recordStopInProgress = false;
      this.recordSaveStarted = false;
      if (!this.isUnloaded) {
        this.setData({
          recordStatus: 'ready',
          recordElapsedText: '0:00'
        });
      }
      if (!this.isUnloaded) {
        wx.showToast({ title: '未获取到视频', icon: 'none' });
      }
      if (options.callback) options.callback();
      return;
    }

    if (!this.isUnloaded) {
      this.setData({ recordStatus: 'saving' });
      wx.showLoading({ title: options.toastTitle || '正在保存...' });
    }

    wx.saveVideoToPhotosAlbum({
      filePath: tempVideoPath,
      success: () => {
        if (!this.isUnloaded) {
          wx.hideLoading();
          wx.showToast({ title: '已保存到相册', icon: 'success' });
          this.setData({
            recordStatus: 'ready',
            recordElapsedText: '0:00'
          });
        }
        this.recordStopInProgress = false;
        this.recordSaveStarted = false;
        if (options.callback) options.callback();
      },
      fail: (err) => {
        if (!this.isUnloaded) {
          wx.hideLoading();
          if (err.errMsg && err.errMsg.includes('auth')) {
             wx.showToast({ title: '请授权保存到相册', icon: 'none' });
          } else {
             wx.showToast({ title: '保存失败', icon: 'error' });
          }
          this.setData({
            recordStatus: 'ready',
            recordElapsedText: '0:00'
          });
        }
        console.warn('[record save fail]', err);
        this.recordStopInProgress = false;
        this.recordSaveStarted = false;
        if (options.callback) options.callback();
      }
    });
  },

  switchCamera: function() {
    const newPosition = this.data.devicePosition === 'front' ? 'back' : 'front';
    this.setData({ devicePosition: newPosition });
  },

  onShareAppMessage: function() {
    return { title: '随声提词', path: '/pages/index/index' };
  }
});
