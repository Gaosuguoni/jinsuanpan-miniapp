// 金算盘记账工具 · P0+P1+P2
// 云开发初始化：没填环境 ID / 被手动切到本地 / 无 wx.cloud 时，自动走"本地演示模式"。
var config = require('./config');

App({
  globalData: {
    cloudOK: false,
    env: config.cloudEnv,
    initTried: false
  },
  onLaunch: function () {
    this.initCloud();
  },
  // 尝试连接云开发；可在用户点"连接云开发"时再次调用
  initCloud: function () {
    if (wx.getStorageSync('vp_force_demo')) { this.globalData.cloudOK = false; return false; }
    if (!config.cloudEnv) { this.globalData.cloudOK = false; return false; }
    if (this.globalData.initTried) return this.globalData.cloudOK;
    var ok = false;
    try {
      if (wx.cloud) {
        wx.cloud.init({ env: config.cloudEnv, traceUser: true });
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    this.globalData.initTried = true;
    this.globalData.cloudOK = ok;
    return ok;
  },
  // 是否使用云开发（用户可手动切到本地演示）
  getCloudOK: function () {
    if (wx.getStorageSync('vp_force_demo')) return false;
    return this.globalData.cloudOK;
  }
});