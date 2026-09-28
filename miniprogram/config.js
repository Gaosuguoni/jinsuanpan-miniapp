// ====== 你的配置 ======
// cloudEnv：云开发环境 ID（语音识别走云端，必须填对）。
// 说明：语音识别由云函数 asr 调用腾讯云语音识别完成，密钥配置在【云函数】里，
//       不在这个小程序端文件里（安全考虑，客户端不存放任何密钥）。
module.exports = {
  cloudEnv: 'cloud1-d9g5r04vt326e0025',
  forceDemo: false
};