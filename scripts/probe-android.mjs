import { connectWebView } from './webview-cdp.mjs'
const cdp = await connectWebView()
try {
  console.log(
    JSON.stringify(
      await cdp.evaluate(`(async () => {
    const bridge = window.OhMyDeepSeekAndroid;
    if (bridge.readApiKey()) throw new Error('Refusing to overwrite an existing credential');
    const written = bridge.writeApiKey('ohmydeepseek-local-test-key');
    const read = bridge.readApiKey() === 'ohmydeepseek-local-test-key';
    bridge.writeApiKey(null);
    let network;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://api.deepseek.com/models', {headers:{Authorization:'Bearer ohmydeepseek-local-test-key'},signal:controller.signal});
      network = {status:response.status,contentType:response.headers.get('content-type')};
    } catch (error) { network = {error:String(error)}; }
    finally { clearTimeout(timer); }
    return {written,read,cleared:bridge.readApiKey()==null,network};
  })()`)
    )
  )
} finally {
  cdp.close()
}
