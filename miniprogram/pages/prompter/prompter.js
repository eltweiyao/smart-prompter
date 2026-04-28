const plugin = requirePlugin("wechat-si");
const manager = plugin.getRecordRecognitionManager();
const { SmartMatcher } = require('../../utils/matcher.js');
const { STORAGE_KEYS } = require('../../utils/helpers.js');

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
    recordStatus: 'ready',  // ready, recording, paused
    activeSettingsTab: 'display',
    cameraStyle: '',
    showGuide: false,
    smartStatusText: '',
    smartStatusType: 'idle',
    isDragging: false,
  },

  contentHeight: 0,
  viewportHeight: 0,
  matcher: null,
  lastTouchY: 0,
  uiHideTimer: null,
  lastRecognizedLength: 0,
  cameraContext: null,
  layoutTimer: null,
  resizeMeasureTimer: null,
  recognitionRestartTimer: null,
  orientationTimer: null,
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
    query.select('.text-content').boundingClientRect();
    query.select('.prompter-viewport').boundingClientRect();
    query.exec((res) => {
      if (res && res[0] && res[1]) {
        this.contentHeight = res[0].height;
        this.viewportHeight = res[1].height;
        if (callback) callback({ contentHeight: this.contentHeight, viewportHeight: this.viewportHeight });
      } else if (callback) {
        callback(null);
      }
    });
  },

  getSmartFollowOffset: function(progress) {
    const lineHeightPx = Math.max(1, this.data.fontSize * this.data.lineHeight);
    const rawDistance = Math.max(0, this.contentHeight * progress);
    const predictedDistance = rawDistance + lineHeightPx * 0.25;
    const snappedDistance = Math.floor(predictedDistance / lineHeightPx) * lineHeightPx + lineHeightPx;
    const maxDistance = Math.max(0, this.contentHeight - lineHeightPx);
    return -Math.min(snappedDistance, maxDistance);
  },

  updateSmartFollowOffset: function(progress) {
    const targetOffset = this.getSmartFollowOffset(progress);
    if (targetOffset < this.data.offsetY) {
      this.setData({ offsetY: targetOffset });
    }
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

      // 注册语音识别回调
      manager.onRecognize = (res) => {
        if (this.isUnloaded) return;
        const text = res.result || '';
        const delta = text.slice(this.lastRecognizedLength);
        this.lastRecognizedLength = text.length;

        if (delta && this.matcher) {
          const progress = this.matcher.match(delta);
          if (progress !== null) {
            this.updateSmartFollowOffset(progress);
          }
        }
      };

      manager.onStop = (res) => {
        if (!this.isUnloaded && this.data.isRunning && this.data.mode === 'smart') {
          this.lastRecognizedLength = 0;
          this.setData({
            smartStatusText: '聆听中',
            smartStatusType: 'listening'
          });
          manager.start({ duration: 60000, lang: "zh_CN" });
        }
      };

      manager.onError = (res) => {
        if (this.data.isRunning && this.data.mode === 'smart') {
          if (this.recognitionRestartTimer) {
            clearTimeout(this.recognitionRestartTimer);
          }
          this.recognitionRestartTimer = setTimeout(() => {
            this.recognitionRestartTimer = null;
            if (!this.isUnloaded && this.data.isRunning && this.data.mode === 'smart') {
              this.setData({
                smartStatusText: '聆听中',
                smartStatusType: 'listening'
              });
              manager.start({ duration: 60000, lang: "zh_CN" });
            }
          }, 1000);
        }
      };

      // 启动定时器：每 500ms 调用一次 tick() 进行预测推进
      this.predictTimer = setInterval(() => {
        if (this.matcher && !this.isUnloaded && this.data.isRunning) {
          const progress = this.matcher.tick();
          if (progress !== null) {
            this.updateSmartFollowOffset(progress);
          }
        }
      }, 500);

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
    if (!this.isUnloaded) {
      this.setData({
        isRunning: false,
        smartStatusText: '',
        smartStatusType: 'idle'
      });
    }

    // 清除预测定时器
    if (this.predictTimer) {
      clearInterval(this.predictTimer);
      this.predictTimer = null;
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
    }
  },

  // --- Helpers & UI ---
  switchSettingsTab: function(e) {
    this.setData({ activeSettingsTab: e.currentTarget.dataset.tab });
  },

  onFontSizeChange: function(e) {
    this.setData({ fontSize: e.detail.value }, () => this.initLayoutLoop());
    this.saveSettings();
  },

  onLineHeightChange: function(e) {
    this.setData({ lineHeight: e.detail.value }, () => this.initLayoutLoop());
    this.saveSettings();
  },

  onLetterSpacingChange: function(e) {
    this.setData({ letterSpacing: e.detail.value }, () => this.initLayoutLoop());
    this.saveSettings();
  },

  onTextAlignChange: function(e) {
    this.setData({ textAlign: e.currentTarget.dataset.align }, () => this.initLayoutLoop());
    this.saveSettings();
  },

  onWpmChange: function(e) {
    this.setData({ wordsPerMinute: e.detail.value });
    this.saveSettings();
  },

  setSpeedPreset: function(e) {
    this.setData({ wordsPerMinute: Number(e.currentTarget.dataset.wpm) });
    this.saveSettings();
  },

  onCountdownDurationChange: function(e) {
    this.setData({ countdownDuration: e.detail.value });
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
    this.setData({ baselinePercent: e.detail.value });
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
      this.setData({ ...s });
    }
  },

  saveSettings: function() {
    const d = this.data;
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
    }
  },

  startRecord: function() {
    if (!this.cameraContext) {
      wx.showToast({ title: '相机未就绪', icon: 'none' });
      return;
    }
    this.cameraContext.startRecord({
      success: () => {
        if (this.isUnloaded) return;
        this.setData({ recordStatus: 'recording' });
        wx.showToast({ title: '开始录制', icon: 'none' });
      },
      fail: () => {
        wx.showToast({ title: '录制失败', icon: 'error' });
      }
    });
  },

  stopRecordAndSave: function(callback) {
    if (!this.cameraContext) {
      if(callback) callback();
      return;
    }
    if (this.data.recordStatus !== 'recording') {
      if(callback) callback();
      return;
    }
    this.cameraContext.stopRecord({
      success: (res) => {
        if (!this.isUnloaded) {
          this.setData({ recordStatus: 'ready' });
        }
        const { tempVideoPath } = res;
        wx.showLoading({ title: '正在保存...' });
        wx.saveVideoToPhotosAlbum({
          filePath: tempVideoPath,
          success: () => {
            wx.hideLoading();
            wx.showToast({ title: '已保存到相册', icon: 'success' });
            if(callback) callback();
          },
          fail: (err) => {
            wx.hideLoading();
            if (err.errMsg.includes('auth')) {
               wx.showToast({ title: '请授权保存到相册', icon: 'none' });
            } else {
               wx.showToast({ title: '保存失败', icon: 'error' });
            }
             if(callback) callback();
          }
        })
      },
      fail: () => {
        wx.showToast({ title: '结束录制失败', icon: 'error' });
        if(callback) callback();
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
