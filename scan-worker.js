/* PRS.AssetVerify — scan-worker.js  (V3 live scanner)
 * Classic Web Worker. Keeps ZXing-C++ WASM resident and decodes camera frames
 * off the main thread so the UI never blocks. Also carries the PRS native
 * Code-11 decoder, which ZXing does not implement.
 */
'use strict';

var ZXING_VERSION = '3.1.3';
var ZXING_URLS = [
  'https://cdn.jsdelivr.net/npm/zxing-wasm@' + ZXING_VERSION + '/dist/iife/reader/index.js',
  'https://unpkg.com/zxing-wasm@' + ZXING_VERSION + '/dist/iife/reader/index.js'
];

var engine = null;
var engineError = '';

function loadEngine() {
  if (engine) return engine;
  for (var i = 0; i < ZXING_URLS.length; i++) {
    try {
      importScripts(ZXING_URLS[i]);
      if (self.ZXingWASM && typeof self.ZXingWASM.readBarcodes === 'function') {
        engine = self.ZXingWASM;
        return engine;
      }
    } catch (e) { engineError = String(e && e.message || e); }
  }
  return null;
}

/* One fast profile per frame; a deeper one every few frames. formats:[] means
 * every symbology ZXing supports — linear, QR family, DataMatrix, Aztec,
 * PDF417, MaxiCode, DataBar and their GS1 variants. */
var PROFILE_FAST = {
  formats: [], tryHarder: false, tryRotate: true, tryInvert: false,
  tryDownscale: true, maxNumberOfSymbols: 4, textMode: 'HRI', returnErrors: false
};
var PROFILE_DEEP = {
  formats: [], tryHarder: true, tryRotate: true, tryInvert: true,
  tryDownscale: true, maxNumberOfSymbols: 8, textMode: 'HRI', returnErrors: false
};

function normalise(results) {
  var out = [];
  if (!results || !results.length) return out;
  for (var i = 0; i < results.length; i++) {
    var r = results[i] || {};
    var value = r.text != null ? r.text : (r.rawValue != null ? r.rawValue : '');
    value = String(value).replace(/\u0000+$/, '').trim();
    if (!value) continue;
    out.push({
      value: value,
      format: String(r.format || ''),
      symbology: String(r.symbologyIdentifier || ''),
      gs1: !!(r.isGS1 || /^\](C1|e0|d2|Q3|J1)/.test(String(r.symbologyIdentifier || ''))),
      bytes: r.bytes ? Array.prototype.slice.call(r.bytes) : null,
      engine: 'zxing'
    });
  }
  return out;
}

function prsCode11Otsu(values){
  const hist=new Uint32Array(256);let total=0,sum=0;
  for(const raw of values){const v=Math.max(0,Math.min(255,Math.round(raw)));hist[v]++;total++;sum+=v}
  if(!total)return 127;
  let sumB=0,wB=0,best=127,maxVar=-1;
  for(let t=0;t<256;t++){
    wB+=hist[t];if(!wB)continue;
    const wF=total-wB;if(!wF)break;
    sumB+=t*hist[t];const mB=sumB/wB,mF=(sum-sumB)/wF,d=mB-mF,v=wB*wF*d*d;
    if(v>maxVar){maxVar=v;best=t}
  }
  return best;
}
function prsCode11Runs(bits){
  if(!bits?.length)return [];
  const runs=[];let black=!!bits[0],width=1;
  for(let i=1;i<bits.length;i++){
    const b=!!bits[i];
    if(b===black)width++;
    else{runs.push({black,width});black=b;width=1}
  }
  runs.push({black,width});
  let changed=true;
  while(changed){
    changed=false;
    for(let i=1;i<runs.length-1;i++){
      if(runs[i].width<=1&&runs[i-1].black===runs[i+1].black){
        runs[i-1].width+=runs[i].width+runs[i+1].width;runs.splice(i,2);changed=true;break;
      }
    }
  }
  return runs;
}
function prsCode11Fit(widths,pattern){
  let nSum=0,nCount=0,wSum=0,wCount=0;
  for(let i=0;i<5;i++){
    if(pattern[i]===1){nSum+=widths[i];nCount++}else{wSum+=widths[i];wCount++}
  }
  if(!nCount||!wCount)return {score:999,narrow:0,wide:0};
  const narrow=nSum/nCount,wide=wSum/wCount,ratio=wide/Math.max(.001,narrow);
  if(ratio<1.42||ratio>5.2)return {score:999,narrow,wide};
  let err=0;
  for(let i=0;i<5;i++){
    const expected=pattern[i]===1?narrow:wide;
    const d=(widths[i]-expected)/Math.max(1,expected);err+=d*d;
  }
  return {score:Math.sqrt(err/5),narrow,wide};
}
function prsCode11Classify(widths){
  let best={score:999,char:'',narrow:0,wide:0};
  for(const [char,pattern] of Object.entries(PRS_CODE11_PATTERNS)){
    const fit=prsCode11Fit(widths,pattern);if(fit.score<best.score)best={...fit,char};
  }
  return best;
}
function prsCode11DecodeRuns(runs){
  const out=[];
  for(let start=0;start+11<runs.length;start++){
    if(!runs[start].black)continue;
    const first=runs.slice(start,start+5);
    if(first.length<5||first.some((r,i)=>r.black!==(i%2===0)))continue;
    const sf=prsCode11Classify(first.map(r=>r.width));
    if(sf.char!=='S'||sf.score>.31)continue;
    let j=start,totalScore=0,symbols=0,data=[],started=false,lastNarrow=sf.narrow;
    while(j+5<=runs.length){
      const five=runs.slice(j,j+5);
      if(five.some((r,i)=>r.black!==(i%2===0)))break;
      const fit=prsCode11Classify(five.map(r=>r.width));
      if(fit.score>.34)break;
      totalScore+=fit.score;symbols++;lastNarrow=fit.narrow;j+=5;
      if(fit.char==='S'){
        if(!started)started=true;
        else{
          const value=data.join('');
          if(value&&/^[0-9-]+$/.test(value)&&value.length<=80){
            const leftQuiet=start>0&&!runs[start-1].black?runs[start-1].width:0;
            const rightQuiet=j<runs.length&&!runs[j].black?runs[j].width:0;
            const quietScore=Math.min(leftQuiet,rightQuiet)/Math.max(1,lastNarrow);
            out.push({value,score:totalScore/Math.max(1,symbols),symbols,start,end:j,quietScore});
          }
          break;
        }
      }else{
        if(!started)break;data.push(fit.char);
      }
      if(j>=runs.length)break;
      const sep=runs[j];if(sep.black)break;
      if(sep.width>Math.max(fit.narrow*2.8,fit.narrow+6))break;
      j++;
    }
  }
  return out;
}
function prsCode11ScanImageData(image,selected=false){
  if(!image?.data||!image.width||!image.height)return [];
  const {data,width:w,height:h}=image,votes=new Map(),yCount=81,half=Math.max(1,Math.min(4,Math.round(h/900)));
  for(let yi=0;yi<yCount;yi++){
    const y=Math.max(0,Math.min(h-1,Math.round((.07+(.86*yi/(yCount-1)))*(h-1))));
    const profile=new Float32Array(w);
    for(let x=0;x<w;x++){
      let sum=0,n=0;
      for(let dy=-half;dy<=half;dy++){
        const yy=y+dy;if(yy<0||yy>=h)continue;
        const k=(yy*w+x)*4;sum+=.299*data[k]+.587*data[k+1]+.114*data[k+2];n++;
      }
      profile[x]=sum/Math.max(1,n);
    }
    const otsu=prsCode11Otsu(profile);
    for(const threshold of [otsu,Math.max(15,otsu-9),Math.min(240,otsu+9)]){
      const bits=new Uint8Array(w);for(let x=0;x<w;x++)bits[x]=profile[x]<threshold?1:0;
      for(const c of prsCode11DecodeRuns(prsCode11Runs(bits))){
        if(!selected&&c.quietScore>0&&c.quietScore<3.0)continue;
        let v=votes.get(c.value);
        if(!v){v={value:c.value,lines:new Set(),hits:0,bestScore:999,bestQuiet:0};votes.set(c.value,v)}
        v.lines.add(y);v.hits++;v.bestScore=Math.min(v.bestScore,c.score);v.bestQuiet=Math.max(v.bestQuiet,c.quietScore||0);
      }
    }
  }
  return [...votes.values()].map(v=>({...v,lineVotes:v.lines.size,confidence:Math.min(1,(v.lines.size/6)+Math.max(0,.30-v.bestScore))}))
    .filter(v=>selected?(v.lineVotes>=2||v.bestScore<=.17):(v.lineVotes>=3&&v.bestScore<=.27))
    .sort((a,b)=>b.lineVotes-a.lineVotes||a.bestScore-b.bestScore||b.value.length-a.value.length);
}

function code11Pass(imageData, selected) {
  try {
    var votes = prsCode11ScanImageData(imageData, !!selected);
    if (!votes || !votes.length) return [];
    return [{ value: votes[0].value, format: 'Code11', symbology: '', gs1: false, bytes: null, engine: 'prs-code11' }];
  } catch (e) { return []; }
}

self.onmessage = function (event) {
  var msg = event.data || {};

  if (msg.type === 'warm') {
    var ok = !!loadEngine();
    if (ok) {
      // Force the .wasm to download and instantiate now, so the first real
      // frame is not paying for a cold start.
      try {
        var probe = new ImageData(new Uint8ClampedArray(4 * 8 * 8), 8, 8);
        engine.readBarcodes(probe, PROFILE_FAST)
          .then(function () { self.postMessage({ type: 'ready', ok: true }); })
          .catch(function () { self.postMessage({ type: 'ready', ok: true }); });
        return;
      } catch (e) { /* fall through */ }
    }
    self.postMessage({ type: 'ready', ok: ok, error: engineError });
    return;
  }

  if (msg.type !== 'frame') return;

  var id = msg.id;
  var imageData;
  try {
    imageData = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
  } catch (e) {
    self.postMessage({ type: 'result', id: id, results: [], error: 'bad frame' });
    return;
  }

  var eng = loadEngine();
  var profile = msg.deep ? PROFILE_DEEP : PROFILE_FAST;
  if (msg.formats && msg.formats.length) profile = Object.assign({}, profile, { formats: msg.formats });

  var finish = function (results) {
    if ((!results || !results.length) && msg.code11) {
      results = code11Pass(imageData, msg.code11 === 'selected');
    }
    self.postMessage({ type: 'result', id: id, results: results || [] });
  };

  if (!eng) { finish([]); return; }

  var started = Date.now();
  eng.readBarcodes(imageData, profile)
    .then(function (r) {
      var out = normalise(r);
      if (out.length) {
        self.postMessage({ type: 'result', id: id, results: out, ms: Date.now() - started });
        return;
      }
      finish([]);
    })
    .catch(function () { finish([]); });
};
