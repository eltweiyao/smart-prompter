const plugin = requirePlugin("wechat-si");
const manager = plugin.getRecordRecognitionManager();
const AnchorTextMatcher = require('../../utils/matcher.js');

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
    devicePosition: 'front',
    recordStatus: 'ready', 
    activeSettingsTab: 'display',
    cameraStyle: '',
    showGuide: false,
  },
  
  contentHeight: 0,
  viewportHeight: 0, 
  matcher: null,
  lastTouchY: 0, 
  uiHideTimer: null,
  cameraContext: null,

  closeGuide: function() {
    this.setData({ showGuide: false });
  },

  onLoad: function(options) {
    const sysInfo = wx.getSystemInfoSync();
    this.setData({ 
      statusBarHeight: sysInfo.statusBarHeight,
      isLandscape: sysInfo.windowWidth > sysInfo.windowHeight
    });
    this.updateCameraView();
    this.loadSettings();
    this.updateStatusBarColor(this.data.bgColor);

    if (options.content) {
      this.setData({ content: decodeURIComponent(options.content) }, () => this.initLayoutLoop());
    } else if (options.id) {
      this.loadScript(options.id);
    }

    if (!wx.getStorageSync('hasSeenGuide')) {
       this.setData({ showGuide: true });
       wx.setStorageSync('hasSeenGuide', true);
    }
    wx.setKeepScreenOn({ keepScreenOn: true });
  },

  onReady: function() {
    this.initLayoutLoop();
    this.resetUiAutoHide();
  },

  initLayoutLoop: function() {
    this.measureLayout((layout) => {
      if (!layout || layout.contentHeight <= 0) {
        setTimeout(() => this.initLayoutLoop(), 500);
      }
    });
  },

  measureLayout: function(callback) {
    const query = wx.createSelectorQuery().in(this);
    query.select('.text-content').boundingClientRect();
    query.select('.prompter-viewport').boundingClientRect();
    query.exec((res) => {
      if (res && res[0] && res[1]) {
        this.contentHeight = res[0].height;
        this.viewportHeight = res[1].height;
        console.log('✅ Layout Measured:', this.contentHeight);
        if (callback) callback({ contentHeight: this.contentHeight, viewportHeight: this.viewportHeight });
      } else if (callback) {
        callback(null);
      }
    });
  },

  loadScript: function(id) {
    const scripts = wx.getStorageSync('scripts') || [];
    const script = scripts.find(s => s.id === id);
    if (script) {
      this.setData({ content: script.content }, () => this.initLayoutLoop());
    }
  },

  startBasicScroll: function() {
    console.log('🚀 Start Basic Scroll Request');
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

  startSmartFollow: function() {
    console.log('🎙️ Start Smart Follow Request');
    this.measureLayout((layout) => {
      if (!layout || layout.contentHeight <= 0) {
        wx.showToast({ title: '台本未就绪', icon: 'none' });
        return;
      }

      this.setData({ isRunning: true });
      const currentProgress = Math.abs(this.data.offsetY) / this.contentHeight;
      this.matcher = new AnchorTextMatcher(this.data.content, Math.floor(this.data.content.length * currentProgress));
      this.lastRecognizedLength = 0;

      manager.onRecognize = (res) => {
        const text = res.result;
        const delta = text.slice(this.lastRecognizedLength);
        this.lastRecognizedLength = text.length;
        if (delta) {
          const progress = this.matcher.match(delta);
          if (progress !== null) {
            this.setData({ offsetY: - (this.contentHeight * progress) });
          }
        }
      };

      manager.onStop = (res) => {
        if (this.data.isRunning && this.data.mode === 'smart') {
          this.lastRecognizedLength = 0;
          manager.start({ duration: 60000, lang: "zh_CN" });
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
    if (this.data.mode === 'basic') {
      this.freezeBasicScroll();
    } else {
      this.stopSmartFollow();
    }
    this.setData({ isRunning: false, countdown: 0 });
  },

  freezeBasicScroll: function() {
    wx.createSelectorQuery().in(this).select('.prompter-content').fields({ computedStyle: ['transform'] }).exec((res) => {
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
    this.setData({ isRunning: false });
    try { manager.stop(); } catch(e) {}
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
      // Smart mode handles pause via stopAll implicitly if needed, or keep ASR
    }
    this.lastTouchY = e.touches[0].clientY;
    this.isScrolling = false;
  },

  onTouchMove: function(e) {
    this.isScrolling = true;
    const delta = e.touches[0].clientY - this.lastTouchY;
    this.lastTouchY = e.touches[0].clientY;
    this.setData({ offsetY: this.data.offsetY + delta, transitionStyle: 'none' });
  },

  onTouchEnd: function() {
    if (this.wasRunning && this.data.mode === 'basic') {
      this.runBasicScrollAnimation();
      this.wasRunning = false;
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
    this.setData({ textAlign: e.currentTarget.dataset.align });
    this.saveSettings();
  },

  onWpmChange: function(e) { 
    this.setData({ wordsPerMinute: e.detail.value }); 
    this.saveSettings(); 
  },

  onCountdownDurationChange: function(e) { 
    this.setData({ countdownDuration: e.detail.value }); 
    this.saveSettings(); 
  },

  setFontColor: function(e) { 
    this.setData({ fontColor: e.currentTarget.dataset.color }); 
    this.saveSettings(); 
  },

  setBgColor: function(e) { 
    const color = e.currentTarget.dataset.color;
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
    const s = wx.getStorageSync('prompter_settings');
    if (s) this.setData({ ...s });
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
    wx.setStorageSync('prompter_settings', s);
  },
  updateStatusBarColor: function(c) {
    wx.setNavigationBarColor({ 
      frontColor: c === '#ffffff' ? '#000000' : '#ffffff', 
      backgroundColor: c === '#00b140' ? '#00b140' : '#000000' 
    });
  },

  updateCameraView: function() {
    const s = wx.getSystemInfoSync();
    const style = s.windowWidth > s.windowHeight ? `width: ${s.windowHeight * (s.screenWidth/s.screenHeight)}px; height: 100%;` : 'width: 100%; height: 100%;';
    this.setData({ cameraStyle: style });
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
    this.setData({ uiHidden: false });
    if (this.data.mode === 'basic' && !this.data.isRunning) {
      this.uiHideTimer = setTimeout(() => this.setData({ uiHidden: true }), 5000);
    }
  },
  onShareAppMessage: function() { return { title: '智能题词器', path: '/pages/index/index' }; }
});
