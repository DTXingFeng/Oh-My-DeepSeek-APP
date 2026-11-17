import { connectWebView, adb } from './webview-cdp.mjs'
const cdp = await connectWebView()
try {
  const mode = process.argv[2] || 'inspect'
  if (mode === 'export') {
    console.log(await cdp.evaluate(`(() => {
      window.__exportResult=null;
      window.addEventListener('ohmydeepseek-export-result',event=>window.__exportResult=event.detail,{once:true});
      const anchor=document.createElement('a');anchor.download='ohmydeepseek-smoke.txt';
      anchor.href=URL.createObjectURL(new Blob(['Oh My DeepSeek export test 中文'],{type:'text/plain'}));
      document.body.append(anchor);anchor.click();anchor.remove();return 'export requested';
    })()`))
  } else if (mode === 'pick') {
    console.log(await cdp.evaluate(`(() => {
      window.__pickedFile=null;
      const input=document.querySelector('input[type=file]');
      input.addEventListener('change',async event=>{const file=event.target.files?.[0];if(file)window.__pickedFile={name:file.name,text:await file.text()}},{once:true,capture:true});
      input.click();return 'picker requested';
    })()`))
  } else if (mode === 'audio') {
    console.log(await cdp.evaluate(`(() => {
      window.__audioResult=null;
      navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
        window.__audioResult={tracks:stream.getAudioTracks().length};stream.getTracks().forEach(track=>track.stop());
      }).catch(error=>window.__audioResult={error:error.name});return 'microphone requested';
    })()`))
  } else {
    console.log(await cdp.evaluate('JSON.stringify({exportResult:window.__exportResult,pickedFile:window.__pickedFile,audioResult:window.__audioResult,local:location.href})'))
  }
} finally { cdp.close() }
console.log(adb('shell', 'dumpsys', 'window').split('\n').filter(line=>line.includes('mCurrentFocus')).join('\n'))
