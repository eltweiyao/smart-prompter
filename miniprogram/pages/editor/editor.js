Page({
  data: {
    id: null,
    title: '',
    content: ''
  },
  onLoad: function(options) {
    if (options.id) {
      this.setData({ id: options.id });
      this.loadScript(options.id);
      wx.setNavigationBarTitle({ title: '修改脚本' });
    } else {
      wx.setNavigationBarTitle({ title: '新建脚本' });
    }
  },
  loadScript: function(id) {
    const scripts = wx.getStorageSync('scripts') || [];
    const script = scripts.find(s => s.id === id);
    if (script) {
      this.setData({
        title: script.title,
        content: script.content
      });
    }
  },
  onTitleInput: function(e) {
    this.setData({ title: e.detail.value });
  },
  onContentInput: function(e) {
    this.setData({ content: e.detail.value });
  },
  saveScript: function() {
    if (!this.data.content) {
      wx.showToast({ title: '内容不能为空', icon: 'none' });
      return;
    }

    let scripts = wx.getStorageSync('scripts') || [];
    const now = new Date();
    const timeString = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;

    if (this.data.id) {
      // Update
      const index = scripts.findIndex(s => s.id === this.data.id);
      if (index > -1) {
        scripts[index].title = this.data.title;
        scripts[index].content = this.data.content;
        scripts[index].updatedAt = timeString;
      }
    } else {
      // Create
      scripts.push({
        id: Date.now().toString(),
        title: this.data.title,
        content: this.data.content,
        updatedAt: timeString
      });
    }

    wx.setStorageSync('scripts', scripts);
    wx.navigateBack();
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