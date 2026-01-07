App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        // env Parameter, if not filled, default environment will be used
        traceUser: true,
      })
    }

    this.globalData = {}
  }
})