const { STORAGE_KEYS, CONFIG, formatDate, processContent } = require('../../utils/helpers.js');

Page({
  data: {
    content: '',
    orientation: 'auto',
    isRecording: false,
    recentScripts: [],
    inputHeight: 400
  },

  onShow: function() {
    this.loadHistory();
  },

  adjustInputHeight: function(e) {
    const delta = parseInt(e.currentTarget.dataset.delta);
    let newHeight = this.data.inputHeight + delta;
    if (newHeight < 200) newHeight = 200;
    if (newHeight > 1200) newHeight = 1200;
    this.setData({ inputHeight: newHeight });
  },

  onInput: function(e) {
    this.setData({ content: e.detail.value });
  },

  processContent: function() {
    const content = processContent(this.data.content);
    if (!content) {
      wx.showToast({ title: '内容不能为空', icon: 'none' });
      return;
    }
    this.setData({ content });
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

  loadHistory: function(e) {
    if (e && e.currentTarget && e.currentTarget.dataset.item) {
      const item = e.currentTarget.dataset.item;
      this.setData({ content: item.content });
      wx.vibrateShort();
    } else {
      let history = wx.getStorageSync(STORAGE_KEYS.HISTORY) || [];
      history.forEach(item => {
        item.displayTime = formatDate(item.timestamp);
      });
      this.setData({ recentScripts: history });
    }
  },

  addToHistory: function(content) {
    let history = wx.getStorageSync(STORAGE_KEYS.HISTORY) || [];
    history = history.filter(h => h.content !== content);

    history.unshift({
      id: Date.now(),
      content: content,
      timestamp: Date.now()
    });

    if (history.length > CONFIG.MAX_HISTORY_COUNT) {
      history = history.slice(0, CONFIG.MAX_HISTORY_COUNT);
    }

    wx.setStorageSync(STORAGE_KEYS.HISTORY, history);
    this.loadHistory();
  },

  deleteHistory: function(e) {
    const id = String(e.currentTarget.dataset.id);
    const history = (wx.getStorageSync(STORAGE_KEYS.HISTORY) || [])
      .filter(item => String(item.id) !== id);
    wx.setStorageSync(STORAGE_KEYS.HISTORY, history);
    this.loadHistory();
    wx.showToast({ title: '已删除', icon: 'none' });
  },

  startPrompter: function() {
    if (!this.data.content.trim()) {
      wx.showToast({ title: '请输入台本内容', icon: 'none' });
      return;
    }

    this.addToHistory(this.data.content);

    const tempScriptKey = `${STORAGE_KEYS.TEMP_SCRIPT}_${Date.now()}`;
    wx.setStorageSync(tempScriptKey, this.data.content);
    wx.navigateTo({
      url: `/pages/prompter/prompter?tempScriptKey=${tempScriptKey}&orientation=${this.data.orientation}&isRecording=${this.data.isRecording}`,
      fail: () => {
        wx.removeStorageSync(tempScriptKey);
        wx.showToast({ title: '打开提词页失败', icon: 'none' });
      }
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
      title: '随声提词',
      path: '/pages/index/index'
    }
  },

  onShareTimeline: function () {
    return {
      title: '随声提词'
    }
  }
})
