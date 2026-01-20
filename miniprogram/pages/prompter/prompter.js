const plugin = requirePlugin("wechat-si");
const manager = plugin.getRecordRecognitionManager();
let scrollTimer = null;

// --- Helper: Anchor Text Matcher (Optimized for Stream Alignment) ---
class AnchorTextMatcher {
  constructor(fullScript, startIndex = 0) {
    // Keep only Chinese, English, Numbers.
    this.script = fullScript.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    this.scriptLength = this.script.length;
    this.lastIndex = startIndex;
    this.buffer = ''; 
    this.searchWindow = 150; // Reduced window from 300 to 150 for safety
    console.log('AnchorMatcher initialized. Script len:', this.script.length, 'Start:', startIndex);
  }

  match(textDelta) {
    if (!textDelta) return null;
    const cleanDelta = textDelta.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    if (!cleanDelta) return null;

    this.buffer += cleanDelta;
    // Cap buffer to keep search fast
    if (this.buffer.length > 60) this.buffer = this.buffer.slice(-60);

    const windowEnd = Math.min(this.scriptLength, this.lastIndex + this.searchWindow);
    const scriptWindow = this.script.substring(this.lastIndex, windowEnd);
    
    // Search for longest suffix of buffer in script window
    const maxSuffixLen = Math.min(this.buffer.length, 20);
    
    for (let len = maxSuffixLen; len >= 2; len--) {
      const suffix = this.buffer.slice(-len);
      
      // Adaptive threshold: CJK needs fewer chars than English
      const isCJK = /[\u4e00-\u9fa5]/.test(suffix);
      if (!isCJK && len < 4) continue; 

      const idx = scriptWindow.indexOf(suffix);
      if (idx !== -1) {
        // Anti-Jump Logic: Enforce distance constraints based on match quality
        const distance = idx;
        let maxAllowedDist = 20; // Default strict

        if (len >= 8) maxAllowedDist = 150; // High confidence
        else if (len >= 5) maxAllowedDist = 80; // Medium
        else if (len >= 3) maxAllowedDist = 30; // Short
        else maxAllowedDist = 10; // Very short (2 chars) - must be immediate

        if (isCJK) maxAllowedDist *= 1.5;

        if (distance <= maxAllowedDist) {
            const newIndex = this.lastIndex + idx + len;
            if (newIndex > this.lastIndex) {
              this.lastIndex = newIndex;
              return this.lastIndex / this.scriptLength;
            }
            return null; // Match found but didn't advance (shouldn't happen with strict logic)
        }
        // If match found but too far, ignore and continue searching shorter/other suffixes
        // (Though typically indexOf finds closest, so shorter suffix at same spot will also fail)
      }
    }
    return null;
  }
  
  reset() {
    this.lastIndex = 0;
    this.buffer = '';
  }
}



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
    speed: 5,
    isRunning: false,
    showSettings: false,
    isLandscape: false,
    uiHidden: false,
    
    // Transform Engine State
    offsetY: 0,
    transitionStyle: '' // e.g. "transform 5s linear"
  },
  
  // Internal State
  contentHeight: 0,
  viewportHeight: 0, 
  matcher: null,
  lastTouchY: 0, 
  uiHideTimer: null,

  onLoad: function(options) {
    const sysInfo = wx.getSystemInfoSync();
    this.setData({ 
      statusBarHeight: sysInfo.statusBarHeight,
      isLandscape: sysInfo.windowWidth > sysInfo.windowHeight
    });

    // Load User Settings
    this.loadSettings();
    this.updateStatusBarColor(this.data.bgColor);

    if (options.content) {
      const content = decodeURIComponent(options.content);
      this.setData({ content: content });
    } else if (options.id) {
      this.loadScript(options.id);
    }

    if (options.orientation) {
      setTimeout(() => {
        if (options.orientation === 'auto') {
           wx.setPageOrientation({ orientation: 'auto' });
        } else {
           wx.setPageOrientation({ orientation: options.orientation });
        }
      }, 100);
    }
  },

  loadSettings: function() {
    const settings = wx.getStorageSync('prompter_settings');
    if (settings) {
      this.setData({
        fontSize: settings.fontSize || 40,
        lineHeight: settings.lineHeight || 1.6,
        letterSpacing: settings.letterSpacing || 0,
        textAlign: settings.textAlign || 'center',
        baselinePercent: settings.baselinePercent || 50,
        focusEnabled: settings.focusEnabled || false,
        speed: settings.speed || 5,
        countdownDuration: settings.countdownDuration !== undefined ? settings.countdownDuration : 0,
        fontColor: settings.fontColor || '#ffffff',
        bgColor: settings.bgColor || '#000000'
      });
    }
  },

  saveSettings: function() {
    const settings = {
      fontSize: this.data.fontSize,
      lineHeight: this.data.lineHeight,
      letterSpacing: this.data.letterSpacing,
      textAlign: this.data.textAlign,
      baselinePercent: this.data.baselinePercent,
      focusEnabled: this.data.focusEnabled,
      speed: this.data.speed,
      countdownDuration: this.data.countdownDuration,
      fontColor: this.data.fontColor,
      bgColor: this.data.bgColor
    };
    wx.setStorageSync('prompter_settings', settings);
  },

  onUnload: function() {
    this.stopAll();
    this.cancelUiAutoHide();
    wx.setPageOrientation({ orientation: 'portrait' });
  },

  onResize: function(res) {
    const sysInfo = wx.getSystemInfoSync();
    this.setData({ 
      statusBarHeight: sysInfo.statusBarHeight,
      isLandscape: sysInfo.windowWidth > sysInfo.windowHeight
    });
    setTimeout(() => {
      this.measureLayout();
    }, 300);
  },

  loadScript: function(id) {
    const scripts = wx.getStorageSync('scripts') || [];
    const script = scripts.find(s => s.id === id);
    if (script) {
      this.setData({ content: script.content });
    }
  },

  onReady: function() {
    this.measureLayout();
    this.resetUiAutoHide();
  },

  measureLayout: function() {
    const query = wx.createSelectorQuery();
    query.select('.text-content').boundingClientRect();
    query.select('.prompter-viewport').boundingClientRect();
    
    query.exec((res) => {
      if (res[0]) {
        this.contentHeight = res[0].height;
      }
      if (res[1]) {
        this.viewportHeight = res[1].height;
      }
    });
  },

  goBack: function() {
    wx.navigateBack();
  },

  toggleSettings: function() {
    this.setData({ showSettings: !this.data.showSettings });
    this.resetUiAutoHide(); // Interaction resets timer
  },

  switchMode: function(e) {
    const mode = e.currentTarget.dataset.mode;
    if (this.data.mode !== mode) {
      this.stopAll();
      this.setData({ mode: mode }, () => {
        if (mode === 'basic') {
          this.resetUiAutoHide();
        } else {
          this.cancelUiAutoHide();
        }
      });
    }
  },

  onLineHeightChange: function(e) {
    this.setData({ lineHeight: e.detail.value });
    setTimeout(() => this.measureLayout(), 300);
    this.saveSettings();
  },
  onLetterSpacingChange: function(e) {
    this.setData({ letterSpacing: e.detail.value });
    setTimeout(() => this.measureLayout(), 300);
    this.saveSettings();
  },
  onTextAlignChange: function(e) {
    this.setData({ textAlign: e.currentTarget.dataset.align });
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

  onFontSizeChange: function(e) { 
    this.setData({ fontSize: e.detail.value }); 
    setTimeout(() => this.measureLayout(), 300);
    this.saveSettings();
  },
  onSpeedChange: function(e) { 
    this.setData({ speed: e.detail.value }); 
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

  updateStatusBarColor: function(bgColor) {
    if (bgColor === '#ffffff') {
      wx.setNavigationBarColor({
        frontColor: '#000000',
        backgroundColor: '#ffffff',
        animation: { duration: 200, timingFunc: 'easeIn' }
      });
    } else {
      wx.setNavigationBarColor({
        frontColor: '#ffffff',
        backgroundColor: bgColor === '#00b140' ? '#00b140' : '#000000',
        animation: { duration: 200, timingFunc: 'easeIn' }
      });
    }
  },

  // --- UI Auto Hide Logic ---
  resetUiAutoHide: function() {
    if (this.uiHideTimer) {
      clearTimeout(this.uiHideTimer);
      this.uiHideTimer = null;
    }
    
    if (this.data.uiHidden) {
      this.setData({ uiHidden: false });
    }
    
    if (this.data.mode === 'basic' && !this.data.isRunning) {
      this.uiHideTimer = setTimeout(() => {
        if (this.data.mode === 'basic' && !this.data.isRunning) {
           this.setData({ uiHidden: true });
        }
      }, 5000);
    }
  },

  cancelUiAutoHide: function() {
    if (this.uiHideTimer) {
      clearTimeout(this.uiHideTimer);
      this.uiHideTimer = null;
    }
    if (this.data.uiHidden) {
      this.setData({ uiHidden: false });
    }
  },

  stopAll: function() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
      this.setData({ countdown: 0 });
    }
    if (this.data.mode === 'basic') {
      this.freezeBasicScroll();
    } else {
      this.stopSmartFollow();
    }
    this.setData({ isRunning: false }, () => {
      this.resetUiAutoHide(); 
    });
  },

  onScreenTap: function() {
    this.resetUiAutoHide();

    if (this.data.showSettings) {
      this.setData({ showSettings: false });
      return;
    }
    if (this.data.isRunning) {
      this.stopAll();
    } 
  },

  onTouchStart: function(e) {
    this.resetUiAutoHide();

    if (this.data.isRunning) {
      this.stopAll(); 
    }
    this.lastTouchY = e.touches[0].clientY;
  },
  
  onTouchMove: function(e) {
    const currentY = e.touches[0].clientY;
    const delta = currentY - this.lastTouchY;
    this.lastTouchY = currentY;
    
    const newOffset = this.data.offsetY + delta;
    
    this.setData({
      offsetY: newOffset,
      transitionStyle: 'none'
    });
  },
  
  onTouchEnd: function() {
    // When manual scroll finishes, we could also reset the timer
    this.resetUiAutoHide();
  },

  startBasicScroll: function() {
    this.cancelUiAutoHide();
    this.measureLayout();
    if (!this.contentHeight) {
      setTimeout(() => this.startBasicScroll(), 100);
      return;
    }

    // Countdown Logic
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
  },

  runBasicScrollAnimation: function() {
    const currentOffset = this.data.offsetY;
    const targetOffset = -this.contentHeight;
    const distance = Math.abs(targetOffset - currentOffset);
    
    if (distance <= 0) return; 
    
    const pps = this.data.speed * 8 + 10; 
    const duration = distance / pps;
    
    this.setData({
      isRunning: true,
      transitionStyle: `transform ${duration}s linear`,
      offsetY: targetOffset
    });
  },

  freezeBasicScroll: function() {
    const query = wx.createSelectorQuery();
    query.select('.prompter-content').fields({ computedStyle: ['transform'] });
    query.select('.prompter-viewport').boundingClientRect();
    
    query.exec((res) => {
      if (!res[0]) return; // Guard against element not found
      const matrix = res[0].transform;
      let currentY = this.data.offsetY; 
      
      if (matrix && matrix !== 'none') {
        const values = matrix.split('(')[1].split(')')[0].split(',');
        if (values.length === 6) {
          currentY = parseFloat(values[5]);
        }
      }
      
      this.setData({
        isRunning: false,
        transitionStyle: 'none',
        offsetY: currentY
      });
    });
  },

  targetOffsetY: 0,
  smartLoopId: null,

  runSmartLoop: function() {
    if (!this.data.isRunning) return;

    const DEAD_ZONE = 0.1; 
    const LERP_FACTOR = 0.4; 

    const current = this.data.offsetY;
    const target = this.targetOffsetY;
    const diff = target - current;

    if (Math.abs(diff) > DEAD_ZONE) {
      const nextY = current + diff * LERP_FACTOR;
      this.setData({
        offsetY: nextY,
        transitionStyle: 'none'
      });
    }

    this.smartLoopId = this.requestLoop(this.runSmartLoop.bind(this));
  },

  requestLoop: function(cb) {
    return (typeof this.animate === 'function' && typeof wx.requestAnimationFrame === 'function') 
      ? wx.requestAnimationFrame(cb) 
      : setTimeout(cb, 1000 / 60); 
  },

  startSmartFollow: function() {
    this.cancelUiAutoHide();
    this.measureLayout();
    this.setData({ isRunning: true });

    let safeProgress = 0;
    const lineH = this.data.fontSize * this.data.lineHeight;
    if (this.contentHeight > 0) {
        // 减去一行高度的偏移量，以获取当前在基准线处的实际文字进度
        const currentProgress = (Math.abs(this.data.offsetY) - lineH) / this.contentHeight;
        safeProgress = Math.max(0, Math.min(1, currentProgress));
    }
    
    const cleanScript = this.data.content.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    const startIndex = Math.floor(cleanScript.length * safeProgress);

    this.matcher = new AnchorTextMatcher(this.data.content, startIndex);
    this.targetOffsetY = this.data.offsetY;
    this.runSmartLoop();

    // WechatSI Logic
    this.lastRecognizedLength = 0;
    
    manager.onRecognize = (res) => {
        const text = res.result;
        console.log("🎤 正在识别:", text);
        const delta = text.slice(this.lastRecognizedLength);
        this.lastRecognizedLength = text.length;
        
        if (delta) {
             const progress = this.matcher.match(delta);
             if (progress !== null) {
                const targetOffset = - (this.contentHeight * progress) - lineH;
                this.targetOffsetY = targetOffset;
             }
        }
    }
    
    manager.onStart = (res) => {
        console.log("✅ 语音识别已启动");
    }
    
    manager.onStop = (res) => {
        console.log("🛑 语音识别停止", res.result);
        if (this.data.isRunning) {
            this.lastRecognizedLength = 0;
            manager.start({ duration: 60000, lang: "zh_CN" });
        }
    }
    
    manager.onError = (res) => {
        console.error("ASR Error", res);
    }

    manager.start({ duration: 60000, lang: "zh_CN" });
  },

  stopSmartFollow: function() {
    manager.stop();
    
    if (this.smartLoopId) {
        if (typeof wx.cancelAnimationFrame === 'function') {
            wx.cancelAnimationFrame(this.smartLoopId);
        } else {
            clearTimeout(this.smartLoopId);
        }
        this.smartLoopId = null;
    }
    // isRunning is set in stopAll
  },
})