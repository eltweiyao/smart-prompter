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
    this.searchWindow = 80; // Reduced window from 150 to 80 for safety
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
    wordsPerMinute: 180,
    isRunning: false,
    showSettings: false,
    isLandscape: false,
    uiHidden: false,
    
    // Transform Engine State
    offsetY: 0,
    transitionStyle: '', // e.g. "transform 5s linear"
    
    // Recording State
    isRecording: false,
    devicePosition: 'front',
    recordStatus: 'ready', // 'ready', 'recording', 'paused'
    activeSettingsTab: 'display',
    cameraStyle: '',
    showGuide: false,
  },
  
  // Internal State
  contentHeight: 0,
  viewportHeight: 0, 
  matcher: null,
  lastTouchY: 0, 
  uiHideTimer: null,
  cameraContext: null,

  closeGuide: function() {
    this.setData({ showGuide: false });
  },

  switchSettingsTab: function(e) {
    this.setData({
      activeSettingsTab: e.currentTarget.dataset.tab
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

  onLoad: function(options) {
    const sysInfo = wx.getSystemInfoSync();
    this.setData({ 
      statusBarHeight: sysInfo.statusBarHeight,
      isLandscape: sysInfo.windowWidth > sysInfo.windowHeight,
      showSettings: false // Explicitly ensure settings are closed on load
    });

    this.updateCameraView();

    // Check Guide
    const hasSeenGuide = wx.getStorageSync('hasSeenGuide');
    if (!hasSeenGuide) {
       this.setData({ showGuide: true });
       wx.setStorageSync('hasSeenGuide', true);
    }

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

    if (options.isRecording === 'true') {
      this.setData({ isRecording: true, bgColor: 'transparent' });
      this.initCamera();
    }
    wx.setKeepScreenOn({ keepScreenOn: true });
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
                  // Context creation will be handled by onCameraReady
                },
                fail: () => {
                  wx.showToast({ title: '录像功能需要授权', icon: 'none' });
                  this.setData({ isRecording: false, bgColor: '#000000' });
                }
              })
            },
            fail: () => {
              wx.showToast({ title: '相机功能需要授权', icon: 'none' });
              this.setData({ isRecording: false, bgColor: '#000000' });
            }
          })
        }
        // Permissions are already granted, do nothing here.
        // Context creation will be handled by onCameraReady
      }
    })
  },

  onCameraReady: function() {
    console.log("Camera is ready.");
    this.cameraContext = wx.createCameraContext();
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
        wordsPerMinute: settings.wordsPerMinute || 180,
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
      wordsPerMinute: this.data.wordsPerMinute,
      countdownDuration: this.data.countdownDuration,
      fontColor: this.data.fontColor,
      bgColor: this.data.bgColor
    };
    wx.setStorageSync('prompter_settings', settings);
  },

  onUnload: function() {
    this.stopAll();
    if (this.data.isRecording) {
      this.stopRecordAndSave();
    }
    this.cancelUiAutoHide();
    wx.setPageOrientation({ orientation: 'portrait' });
    wx.setKeepScreenOn({ keepScreenOn: false });
  },

  onResize: function(res) {
    const sysInfo = wx.getSystemInfoSync();
    const newIsLandscape = sysInfo.windowWidth > sysInfo.windowHeight;

    this.setData({ 
      statusBarHeight: sysInfo.statusBarHeight,
      isLandscape: newIsLandscape
    });

    this.updateCameraView();
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
    if (this.data.isRecording && this.data.recordStatus !== 'ready') {
      this.stopRecordAndSave(() => {
        wx.navigateBack();
      });
    } else {
      wx.navigateBack();
    }
  },

  toggleSettings: function() {
    console.log('toggleSettings called, current showSettings:', this.data.showSettings, 'isLandscape:', this.data.isLandscape);
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

  // --- Recording Controls ---
  switchCamera: function() {
    if (!this.data.isRecording) return;
    const newPosition = this.data.devicePosition === 'front' ? 'back' : 'front';
    this.setData({ devicePosition: newPosition });
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
    }
  },

  startRecord: function() {
    this.cameraContext.startRecord({
      success: () => {
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
    this.cameraContext.stopRecord({
      success: (res) => {
        this.setData({ recordStatus: 'ready' });
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

    if (this.isScrolling) {
      return; // It's a scroll, not a tap
    }

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

    if (this.momentumId) {
      if (typeof wx.cancelAnimationFrame === 'function') {
        wx.cancelAnimationFrame(this.momentumId);
      } else {
        clearTimeout(this.momentumId);
      }
      this.momentumId = null;
    }

    // Logic Change: Pause instead of Stop
    if (this.data.isRunning) {
      this.wasRunning = true;
      if (this.data.mode === 'basic') {
        this.pauseBasicScroll();
      } else {
        this.stopSmartLoop(); // Pause loop, keep ASR
      }
    } else {
      this.wasRunning = false;
    }

    this.lastTouchY = e.touches[0].clientY;
    this.lastTouchTs = e.timeStamp;
    this.lastSpeed = 0;
    this.isScrolling = false; 
    this.pendingPause = false; // Reset safe guard
  },
  
  onTouchMove: function(e) {
    this.isScrolling = true; // User is scrolling
    const currentY = e.touches[0].clientY;
    const currentTs = e.timeStamp;
    const delta = currentY - this.lastTouchY;
    const timeDelta = currentTs - this.lastTouchTs;
    
    this.lastTouchY = currentY;
    this.lastTouchTs = currentTs;

    if (timeDelta > 0) {
      this.lastSpeed = delta / timeDelta;
    }
    
    if (this.pendingPause) {
       // We are waiting for the real starting Y. Accumulate delta.
       if (!this.accumulatedDelta) this.accumulatedDelta = 0;
       this.accumulatedDelta += delta;
    } else {
       const newOffset = this.data.offsetY + delta;
       this.setData({
         offsetY: newOffset,
         transitionStyle: 'none'
       });
    }
  },
  
  onTouchEnd: function() {
    this.resetUiAutoHide();
    this.momentumLoop();
  },

  momentumLoop: function() {
    if (Math.abs(this.lastSpeed) < 0.01) {
      this.lastSpeed = 0;
      
      // Resume logic
      if (this.wasRunning && this.isScrolling) {
         console.log('Resuming after scroll...');
         if (this.data.mode === 'basic') {
           this.runBasicScrollAnimation();
         } else if (this.data.mode === 'smart') {
           this.syncMatcherToOffset();
           this.runSmartLoop();
         }
         this.wasRunning = false;
      }
      return;
    }

    const newOffset = this.data.offsetY + this.lastSpeed * 16.7; // Assuming 60fps
    this.lastSpeed *= 0.95; // Decay factor

    this.setData({
      offsetY: newOffset
    });

    if (typeof wx.requestAnimationFrame === 'function') {
      this.momentumId = wx.requestAnimationFrame(this.momentumLoop.bind(this));
    } else {
      this.momentumId = setTimeout(this.momentumLoop.bind(this), 16);
    }
  },

  pauseBasicScroll: function() {
    this.pendingPause = true;
    this.accumulatedDelta = 0;
    
    const query = wx.createSelectorQuery();
    query.select('.prompter-content').fields({ computedStyle: ['transform'] });
    
    query.exec((res) => {
      this.pendingPause = false; // Callback done
      
      if (!res[0]) return;
      const matrix = res[0].transform;
      let currentY = this.data.offsetY; 
      
      if (matrix && matrix !== 'none') {
        const values = matrix.split('(')[1].split(')')[0].split(',');
        if (values.length === 6) {
          currentY = parseFloat(values[5]);
        }
      }
      
      // Apply any accumulated delta from moves that happened while waiting
      const finalY = currentY + (this.accumulatedDelta || 0);
      
      this.setData({
        transitionStyle: 'none',
        offsetY: finalY
      });
      
      this.accumulatedDelta = 0;
    });
  },

  syncMatcherToOffset: function() {
    if (!this.matcher || !this.contentHeight) return;
    const lineH = this.data.fontSize * this.data.lineHeight;
    const currentProgress = (Math.abs(this.data.offsetY) - lineH) / this.contentHeight;
    const safeProgress = Math.max(0, Math.min(1, currentProgress));
    
    const cleanScript = this.data.content.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    const newIndex = Math.floor(cleanScript.length * safeProgress);
    
    console.log('Syncing matcher to index:', newIndex);
    this.matcher.lastIndex = newIndex;
    this.targetOffsetY = this.data.offsetY;
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

    // Calculate duration based on WPM
    // Chinese characters are counted as words.
    const wordCount = (this.data.content.match(/[\u4e00-\u9fa5]|\b\w+\b/g) || []).length;
    if (wordCount === 0) return;

    const minutes = wordCount / this.data.wordsPerMinute;
    const totalDurationInSeconds = minutes * 60;
    
    // The duration should be proportional to the remaining distance
    const fullDistance = this.contentHeight + this.viewportHeight; // total scrollable distance
    const duration = totalDurationInSeconds * (distance / fullDistance);

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

  runSmartLoop: function() {
    const loop = (timestamp) => {
        if (!this.data.isRunning || this.data.mode !== 'smart') return;
        
        const now = timestamp || Date.now();
        const deltaTime = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 0;
        this.lastFrameTime = now;

        const currentOffset = this.data.offsetY;
        const targetOffset = this.targetOffsetY;
        const diff = targetOffset - currentOffset;

        // If close enough, snap to target and stop excessive updates
        if (Math.abs(diff) < 1) {
            this.setData({ offsetY: targetOffset });
        } else {
            // Apply easing for a smoother approach. 
            // The factor (e.g., 4) controls the "snappiness" of the follow.
            const easeFactor = 4;
            const move = diff * easeFactor * deltaTime;
            
            this.setData({ 
              offsetY: currentOffset + move,
              // We manage the animation manually, so transition is none
              transitionStyle: 'none' 
            });
        }
        
        if (typeof wx.requestAnimationFrame === 'function') {
            this.smartLoopId = wx.requestAnimationFrame(loop);
        } else {
            this.smartLoopId = setTimeout(() => loop(), 33); // Fallback to ~30fps
        }
    };
    
    this.lastFrameTime = null; // Reset time for the new loop
    loop();
  },

  stopSmartLoop: function() {
    if (this.smartLoopId) {
      if (typeof wx.cancelAnimationFrame === 'function') {
          wx.cancelAnimationFrame(this.smartLoopId);
      } else {
          clearTimeout(this.smartLoopId);
      }
      this.smartLoopId = null;
    }
  },

  stopSmartFollow: function() {
    manager.stop();
    this.stopSmartLoop();
    // isRunning is set in stopAll
  },

  onShareAppMessage: function () {
    return {
      title: '智能题词器',
      path: '/pages/index/index'
    }
  },

  onShareTimeline: function () {
    return {
      title: '智能题词器'
    }
  }
})