const recorderManager = wx.getRecorderManager();
let scrollTimer = null;

// --- Configuration ---
// Qwen-ASR Realtime API Configuration
const ASR_CONFIG = {
  URL: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', 
  // REPLACE WITH YOUR DASHSCOPE API KEY
  TOKEN: 'sk-bf789278af0b4c80ab602166a061b5ac',
  MODEL: 'qwen3-asr-flash-realtime'
};

// --- Helper: Fuzzy Text Matcher (Tolerant to ASR errors) ---
class FuzzyTextMatcher {
  constructor(fullScript) {
    // Keep only Chinese, English, Numbers.
    this.script = fullScript.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    this.originalScript = fullScript;
    this.lastIndex = 0;
    console.log('FuzzyMatcher initialized. Script len:', this.script.length);
  }

  match(partialText) {
    if (!partialText) return null;
    const cleanASR = partialText.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    if (cleanASR.length === 0) return null;

    // Parameters
    const SEARCH_WINDOW = 200; // Look ahead 200 chars
    const MATCH_THRESHOLD = 0.6; // 60% similarity required
    
    // Optimization: If exact match exists, take it immediately
    const exactIdx = this.script.indexOf(cleanASR, this.lastIndex);
    if (exactIdx !== -1 && (exactIdx - this.lastIndex) < SEARCH_WINDOW) {
      this.lastIndex = exactIdx + cleanASR.length;
      return this.lastIndex / this.script.length;
    }

    // Heuristic: Compare cleanASR with a slice of script
    const compareLen = Math.min(cleanASR.length * 2 + 10, SEARCH_WINDOW); 
    const scriptSlice = this.script.substr(this.lastIndex, compareLen);
    
    const { score, matchEndOffset } = this.calculateFuzzyScore(cleanASR, scriptSlice);

    // console.log(`Fuzzy: Input="${cleanASR}" Score=${score.toFixed(2)}`);

    if (score > MATCH_THRESHOLD) {
      // Valid match found
      // Update index to: lastIndex + relative match end
      this.lastIndex = this.lastIndex + matchEndOffset;
      return this.lastIndex / this.script.length;
    }

    return null;
  }

  // Calculates similarity score (0-1) and end position
  calculateFuzzyScore(asr, scriptChunk) {
    if (!scriptChunk) return { score: 0, matchEndOffset: 0 };

    let scriptCursor = 0;
    let matchCount = 0;
    let lastMatchIndex = 0;

    for (let i = 0; i < asr.length; i++) {
      const char = asr[i];
      // Find this char in scriptChunk starting from scriptCursor
      const foundIdx = scriptChunk.indexOf(char, scriptCursor);
      
      if (foundIdx !== -1) {
        matchCount++;
        scriptCursor = foundIdx + 1; // Advance script cursor
        lastMatchIndex = foundIdx + 1; // Record end of this char match
      }
    }

    const score = matchCount / asr.length;
    return { score, matchEndOffset: lastMatchIndex };
  }
  
  reset() {
    this.lastIndex = 0;
  }
}

// --- Service: Qwen Realtime ASR Client (OpenAI Protocol) ---
class QwenASRClient {
  constructor(callbacks) {
    this.callbacks = callbacks; 
    this.socket = null;
    this.isRecording = false;
    this.isConnected = false;
    
    // Bind Recorder Events ONCE during initialization
    this.bindRecorderEvents();
  }
  
  bindRecorderEvents() {
    let frameCount = 0;
    
    recorderManager.onFrameRecorded((res) => {
      // Strict guard: Only process if THIS client is active
      if (this.socket && this.isRecording && this.isConnected) {
        frameCount++;
        if (frameCount % 50 === 0) console.log(`🎤 Sending Audio Frames... (${frameCount})`);

        const base64Audio = wx.arrayBufferToBase64(res.frameBuffer);
        
        const appendEvent = {
          type: 'input_audio_buffer.append',
          audio: base64Audio
        };
        
        this.socket.send({ 
          data: JSON.stringify(appendEvent),
          fail: (err) => {
             // console.error('Send Audio Failed:', err);
             // Suppress send errors to avoid spam
             if (err.errMsg && err.errMsg.includes('sendData error')) {
               this.stop();
             }
          }
        });
      }
    });
    
    recorderManager.onError((err) => {
      // Ignore "recorder not start" which happens when we try to stop an idle mic
      if (err.errMsg && err.errMsg.includes('recorder not start')) return;
      
      console.error('❌ Microphone Error:', err);
    });
  }

  start() {
    this.isRecording = true;
    this.isConnected = false;
    
    console.log('--- ASR Client Starting (Realtime API) ---');
    const wssUrl = `${ASR_CONFIG.URL}?model=${ASR_CONFIG.MODEL}`;
    
    this.socket = wx.connectSocket({
      url: wssUrl,
      header: {
        'Authorization': `Bearer ${ASR_CONFIG.TOKEN}`,
        'OpenAI-Beta': 'realtime=v1'
      },
      success: () => console.log('Socket connecting...')
    });

    this.socket.onOpen(() => {
      console.log('✅ ASR Socket Connected');
      this.isConnected = true;
      
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['text'], 
          input_audio_format: 'pcm',
          input_audio_transcription: {
             model: ASR_CONFIG.MODEL,
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            silence_duration_ms: 800
          }
        }
      };
      
      this.socket.send({ data: JSON.stringify(sessionUpdate) });
      this.startMic();
    });
    
    // ... (onMessage, onError, onClose remain same)
    this.socket.onMessage((res) => {
      try {
        const data = JSON.parse(res.data);
        // Debug: Log all event types
        // console.log('📩 Rx Event:', data.type); 

        if (data.type === 'error') {
           console.error('❌ ASR Error Event:', JSON.stringify(data.error));
           return;
        }

        if (data.type === 'session.created') console.log('✅ Session Created');
        if (data.type === 'response.audio_transcript.delta') {
           const text = data.delta;
           console.log('📝 Delta:', text);
           if (text) this.callbacks.onText(text);
        }
        if (data.type === 'conversation.item.input_audio_transcription.completed') {
           const text = data.transcript;
           console.log('✅ Sentence Completed:', text);
           if (text) this.callbacks.onText(text);
        }
      } catch (e) {
        console.error('ASR Parse Error', e);
      }
    });

    this.socket.onError((err) => {
      console.error('❌ ASR Socket Error', err);
      this.isConnected = false;
      this.stop();
    });
    
    this.socket.onClose((res) => {
      console.log('⚠️ ASR Socket Closed', res);
      this.isConnected = false;
      this.stop();
    });
  }

  startMic() {
    console.log('🎤 Starting Microphone...');
    
    // 1. Force Stop to clear state (might trigger 'recorder not start' error, which we ignore now)
    try {
      recorderManager.stop();
    } catch(e) {}

    // 2. Wait and Start
    setTimeout(() => {
      if (!this.isConnected || !this.isRecording) return; 

      recorderManager.start({
        format: 'PCM',
        sampleRate: 16000,
        numberOfChannels: 1,
        frameSize: 2 
      });
    }, 100);
  }

  stop() {
    this.isRecording = false;
    this.isConnected = false;
    recorderManager.stop();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
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
    mode: 'basic', 
    speed: 5,
    isRunning: false,
    showSettings: false,
    
    // Transform Engine State
    offsetY: 0,
    transitionStyle: '' // e.g. "transform 5s linear"
  },
  
  // Internal State
  contentHeight: 0,
  viewportHeight: 0, // Need to track viewport height
  asrClient: null,
  matcher: null,
  
  lastTouchY: 0, // For manual drag

  onLoad: function(options) {
    const sysInfo = wx.getSystemInfoSync();
    this.setData({ statusBarHeight: sysInfo.statusBarHeight });

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

  onUnload: function() {
    this.stopAll();
    wx.setPageOrientation({ orientation: 'portrait' });
  },

  onResize: function(res) {
    const sysInfo = wx.getSystemInfoSync();
    this.setData({ statusBarHeight: sysInfo.statusBarHeight });
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
  },

  measureLayout: function() {
    const query = wx.createSelectorQuery();
    // Measure content height
    query.select('.text-content').boundingClientRect();
    // Measure viewport height
    query.select('.prompter-viewport').boundingClientRect();
    
    query.exec((res) => {
      // Add checks
      if (res[0]) {
        this.contentHeight = res[0].height;
        // console.log('Content Height:', this.contentHeight);
      }
      if (res[1]) {
        this.viewportHeight = res[1].height;
        // console.log('Viewport Height:', this.viewportHeight);
      }
    });
  },

  goBack: function() {
    wx.navigateBack();
  },

  toggleSettings: function() {
    this.setData({ showSettings: !this.data.showSettings });
  },

  switchMode: function(e) {
    const mode = e.currentTarget.dataset.mode;
    if (this.data.mode !== mode) {
      this.stopAll();
      this.setData({ mode: mode });
    }
  },

  onFontSizeChange: function(e) { 
    this.setData({ fontSize: e.detail.value }); 
    setTimeout(() => this.measureLayout(), 300);
  },
  onSpeedChange: function(e) { this.setData({ speed: e.detail.value }); },
  setFontColor: function(e) { this.setData({ fontColor: e.currentTarget.dataset.color }); },
  setBgColor: function(e) { this.setData({ bgColor: e.currentTarget.dataset.color }); },

  stopAll: function() {
    // Determine which mode to stop
    if (this.data.mode === 'basic') {
      this.freezeBasicScroll();
    } else {
      this.stopSmartFollow();
    }
    this.setData({ isRunning: false });
  },

  onScreenTap: function() {
    if (this.data.showSettings) {
      this.setData({ showSettings: false });
      return;
    }
    if (this.data.isRunning) {
      this.stopAll();
    } 
  },

  // --- Manual Scroll Logic (Touch Drag) ---
  onTouchStart: function(e) {
    if (this.data.isRunning) {
      this.stopAll(); // Auto-stop on touch
    }
    this.lastTouchY = e.touches[0].clientY;
  },
  
  onTouchMove: function(e) {
    const currentY = e.touches[0].clientY;
    const delta = currentY - this.lastTouchY;
    this.lastTouchY = currentY;
    
    // Direct manipulation: No transition
    const newOffset = this.data.offsetY + delta;
    
    this.setData({
      offsetY: newOffset,
      transitionStyle: 'none'
    });
  },
  
  onTouchEnd: function() {
    // Optional: Add inertia/fling logic here if desired
  },


  // --- 1. Basic Mode: CSS Transition Engine ---
  
  startBasicScroll: function() {
    this.measureLayout();
    
    // Ensure layout is ready. If contentHeight is 0, retry shortly.
    if (!this.contentHeight) {
      console.warn('Content height is 0, retrying startBasicScroll...');
      setTimeout(() => this.startBasicScroll(), 100);
      return;
    }
    
    const currentOffset = this.data.offsetY;
    // We scroll until the bottom of content aligns with the "Center Line" (padding-space).
    // The content structure is: padding(50vh) + text + padding(50vh).
    // Initial state (offsetY=0): Top padding pushes text to middle.
    // End state: We want text to move UP.
    // Total scrollable distance is roughly contentHeight.
    // Let's set target to -contentHeight which moves everything up significantly.
    const targetOffset = -this.contentHeight;
    const distance = Math.abs(targetOffset - currentOffset);
    
    console.log(`Starting Basic Scroll. From ${currentOffset} to ${targetOffset} (Dist: ${distance})`);
    
    if (distance <= 0) return; 
    
    // Speed Logic: Pixels per Second
    // Slider 1-20. Let's say Speed 10 = 50px/s (readable speed)
    // Speed 1 = 10px/s, Speed 20 = 150px/s
    const pps = this.data.speed * 8 + 10; 
    const duration = distance / pps;
    
    this.setData({
      isRunning: true,
      transitionStyle: `transform ${duration}s linear`,
      offsetY: targetOffset
    });
  },

  freezeBasicScroll: function() {
    // CRITICAL: We need to stop the CSS transition mid-flight and save the current position.
    const query = wx.createSelectorQuery();
    query.select('.prompter-content').fields({ computedStyle: ['transform'] });
    query.select('.prompter-viewport').boundingClientRect();
    
    query.exec((res) => {
      // res[0].transform is like "matrix(1, 0, 0, 1, 0, -123.45)"
      // We need to extract the Y value (-123.45)
      
      const matrix = res[0].transform;
      // console.log('Matrix:', matrix);
      
      let currentY = this.data.offsetY; // Fallback
      
      if (matrix && matrix !== 'none') {
        const values = matrix.split('(')[1].split(')')[0].split(',');
        // Matrix format: a, b, c, d, tx, ty
        if (values.length === 6) {
          currentY = parseFloat(values[5]);
        }
      }
      
      // Force set to current position with NO transition
      this.setData({
        isRunning: false,
        transitionStyle: 'none',
        offsetY: currentY
      });
    });
  },


  // --- 2. Smart Follow Logic ---

  startSmartFollow: function() {
    this.measureLayout();
    this.setData({ isRunning: true });

    this.matcher = new FuzzyTextMatcher(this.data.content);

    this.asrClient = new QwenASRClient({
      onText: (text) => {
        console.log('🎙️ ASR:', text);
        const progress = this.matcher.match(text);
        
        if (progress !== null) {
          // Calculate Line Height Adjustment
          // We want the MIDDLE of the current line to be on the focus line.
          // Currently, progress represents the end of the spoken text.
          const lineHeight = this.data.fontSize * 1.6;
          
          // targetOffset = - (totalTextHeight * progress)
          // To center the line, we adjust by half a line height
          const targetOffset = - (this.contentHeight * progress) + (lineHeight / 2);
          
          // Smart Mode uses snappy transition
          this.setData({
            transitionStyle: 'transform 0.2s ease-out',
            offsetY: targetOffset
          });
        }
      },
      onError: (err) => {}
    });

    this.asrClient.start();
  },

  stopSmartFollow: function() {
    if (this.asrClient) {
      this.asrClient.stop();
      this.asrClient = null;
    }
    // No need to freeze matrix for smart mode usually, 
    // just stop updating is fine. But let's keep consistent state.
    // For Smart Mode, we just stop accepting updates. 
    // The last transition will finish naturally.
    this.setData({ isRunning: false });
  },
})