const app = getApp();

Page({
  data: {
    content: '',
    orientation: 'auto', // 'auto', 'portrait', 'landscape'
    isRecording: false,
    recentScripts: [],
    inputHeight: 400 // Initial height in rpx
  },

  onShow: function() {
    this.loadHistory();
  },

  adjustInputHeight: function(e) {
    const delta = parseInt(e.currentTarget.dataset.delta);
    let newHeight = this.data.inputHeight + delta;
    if (newHeight < 200) newHeight = 200; // Min height
    if (newHeight > 1200) newHeight = 1200; // Max height
    this.setData({ inputHeight: newHeight });
  },

  onInput: function(e) {
    this.setData({ content: e.detail.value });
  },

  clearContent: function() {
    this.setData({ content: '' });
  },

  setOrientation: function(e) {
    this.setData({ orientation: e.currentTarget.dataset.type });
  },

  toggleRecording: function() {
    this.setData({ isRecording: !this.data.isRecording });
  },

  loadHistory: function() {
    let history = wx.getStorageSync('script_history') || [];
    // Format time for display
    history.forEach(item => {
      const date = new Date(item.timestamp);
      item.displayTime = `${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
    });
    this.setData({ recentScripts: history });
  },

  addToHistory: function(content) {
    let history = wx.getStorageSync('script_history') || [];
    // Remove duplicates of exact same content to keep list fresh
    history = history.filter(h => h.content !== content);
    
    // Add new to top
    history.unshift({
      id: Date.now(),
      content: content,
      timestamp: Date.now()
    });

    // Keep only last 10
    if (history.length > 10) {
      history = history.slice(0, 10);
    }
    
    wx.setStorageSync('script_history', history);
    this.loadHistory();
  },

  loadHistory: function(e) {
    // Determine if called from event or manually
    if (e && e.currentTarget && e.currentTarget.dataset.item) {
      const item = e.currentTarget.dataset.item;
      this.setData({ content: item.content });
      wx.vibrateShort(); // Feedback
    } else {
      // Internal load
      let history = wx.getStorageSync('script_history') || [];
      history.forEach(item => {
        const date = new Date(item.timestamp);
        item.displayTime = `${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
      });
      this.setData({ recentScripts: history });
    }
  },

  startPrompter: function() {
    if (!this.data.content.trim()) {
      wx.showToast({ title: '请输入台本内容', icon: 'none' });
      return;
    }

    // Save to history
    this.addToHistory(this.data.content);

    // Navigate with params
    // We encode component to handle special chars/newlines
    const contentEncoded = encodeURIComponent(this.data.content);
    wx.navigateTo({
      url: `/pages/prompter/prompter?content=${contentEncoded}&orientation=${this.data.orientation}&isRecording=${this.data.isRecording}`
    });
  },

  saveScript: function() {
    if (!this.data.content.trim()) {
      wx.showToast({ title: '请输入台本内容', icon: 'none' });
      return;
    }
    this.addToHistory(this.data.content);
    wx.showToast({ title: '已保存', icon: 'success' });
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