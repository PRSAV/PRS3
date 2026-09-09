/* PRS.AssetVerify — prs-scan.js  (V3 universal scanner)
 * Live camera scanning for every symbology ZXing-C++ supports, plus the PRS
 * native Code-11 decoder, plus GS1 element-string parsing and form autofill.
 * Deploy together with scan-worker.js.
 */
(function () {
'use strict';

/* PRS.AssetVerify — payload parser
 * Turns a decoded barcode string into named fields.
 * Handles: GS1 element strings (GS1-128, GS1 DataMatrix, GS1 QR, GS1 DataBar),
 * JSON, key=value / key:value lists, and URLs with query parameters.
 */

/* AI -> [dataLength, label].  dataLength 0 = variable length, terminated by
 * FNC1 (ASCII 29) or end of string. Ranges cover the measurement AIs 31nn-36nn
 * where the final digit is the implied decimal point. */
var GS1_AI = {
  '00': [18, 'SSCC'],
  '01': [14, 'GTIN'],
  '02': [14, 'Content GTIN'],
  '03': [14, 'MTO GTIN'],
  '04': [16, 'Cell GTIN'],
  '10': [0, 'Batch / Lot'],
  '11': [6, 'Production Date'],
  '12': [6, 'Due Date'],
  '13': [6, 'Packaging Date'],
  '15': [6, 'Best Before'],
  '16': [6, 'Sell By'],
  '17': [6, 'Expiry Date'],
  '20': [2, 'Variant'],
  '21': [0, 'Serial Number'],
  '22': [0, 'Consumer Product Variant'],
  '30': [0, 'Quantity'],
  '37': [0, 'Count'],
  '90': [0, 'Internal'],
  '91': [0, 'Internal'], '92': [0, 'Internal'], '93': [0, 'Internal'],
  '94': [0, 'Internal'], '95': [0, 'Internal'], '96': [0, 'Internal'],
  '97': [0, 'Internal'], '98': [0, 'Internal'], '99': [0, 'Internal'],
  '235': [0, 'TPX'],
  '240': [0, 'Additional Item ID'],
  '241': [0, 'Customer Part Number'],
  '242': [0, 'Made-to-Order Variant'],
  '243': [0, 'Packaging Component Number'],
  '250': [0, 'Secondary Serial'],
  '251': [0, 'Reference to Source'],
  '253': [0, 'GDTI'],
  '254': [0, 'GLN Extension'],
  '255': [0, 'GCN'],
  '400': [0, 'Order Number'],
  '401': [0, 'GINC'],
  '402': [17, 'GSIN'],
  '403': [0, 'Routing Code'],
  '410': [13, 'Ship To GLN'],
  '411': [13, 'Bill To GLN'],
  '412': [13, 'Purchased From GLN'],
  '413': [13, 'Ship For GLN'],
  '414': [13, 'Location GLN'],
  '415': [13, 'Invoicing GLN'],
  '416': [13, 'Production GLN'],
  '417': [13, 'Party GLN'],
  '420': [0, 'Ship To Postcode'],
  '421': [0, 'Ship To Postcode (ISO)'],
  '422': [3, 'Country of Origin'],
  '424': [3, 'Country of Processing'],
  '7003': [10, 'Expiry Date and Time'],
  '7007': [0, 'Harvest Date'],
  '7020': [0, 'Refurbishment Lot'],
  '7021': [0, 'Functional Status'],
  '7022': [0, 'Revision Status'],
  '7023': [0, 'GIAI of Assembly'],
  '8003': [0, 'GRAI (Returnable Asset)'],
  '8004': [0, 'GIAI (Individual Asset)'],
  '8005': [6, 'Price Per Unit'],
  '8006': [18, 'ITIP'],
  '8010': [0, 'CPID'],
  '8011': [0, 'CPID Serial'],
  '8013': [0, 'GMN'],
  '8017': [18, 'GSRN Provider'],
  '8018': [18, 'GSRN Recipient'],
  '8019': [0, 'SRIN'],
  '8020': [0, 'Payment Reference'],
  '8026': [18, 'ITIP Content']
};

/* Measurement AIs: 310n..369n, 390n..394n, 703n etc. */
function gs1Lookup(str, pos) {
  var i, ai, four = str.substr(pos, 4), three = str.substr(pos, 3), two = str.substr(pos, 2);

  if (GS1_AI[four]) return { ai: four, len: GS1_AI[four][0], label: GS1_AI[four][1] };
  if (GS1_AI[three]) return { ai: three, len: GS1_AI[three][0], label: GS1_AI[three][1] };
  if (GS1_AI[two]) return { ai: two, len: GS1_AI[two][0], label: GS1_AI[two][1] };

  // Measurement family 31nn-36nn: 4-digit AI, 6-digit fixed data.
  if (/^3[1-6]\d\d$/.test(four)) {
    var kinds = {
      '310': 'Net Weight (kg)', '311': 'Length (m)', '312': 'Width (m)',
      '313': 'Depth (m)', '314': 'Area (m2)', '315': 'Net Volume (l)',
      '316': 'Net Volume (m3)', '320': 'Net Weight (lb)', '330': 'Gross Weight (kg)',
      '340': 'Gross Weight (lb)', '350': 'Area (in2)', '360': 'Net Volume (qt)'
    };
    return { ai: four, len: 6, label: kinds[four.substr(0, 3)] || 'Measurement', decimals: Number(four[3]) };
  }
  // Amount payable family 390n-394n: variable length.
  if (/^39[0-4]\d$/.test(four)) return { ai: four, len: 0, label: 'Amount', decimals: Number(four[3]) };
  if (/^70\d\d$/.test(four)) return { ai: four, len: 0, label: 'Reference' };
  if (/^71\d\d$/.test(four)) return { ai: four, len: 0, label: 'Regulated Identifier' };

  // Unknown 2-digit AI: treat as variable so parsing degrades instead of dying.
  if (/^\d\d$/.test(two)) return { ai: two, len: 0, label: 'AI ' + two, unknown: true };
  return null;
}

var GS = String.fromCharCode(29);   // FNC1 separator

function looksLikeGS1(value, symbology) {
  var s = String(symbology || '');
  if (/^\](C1|e0|d2|Q3|J1)/.test(s)) return true;
  if (value.indexOf(GS) >= 0) return true;
  if (/^\(\d{2,4}\)/.test(value)) return true;                 // bracketed HRI form
  return /^(01|00|8004|8003|414|253)\d{6,}/.test(value);       // common asset AIs
}

function parseGS1(raw) {
  var value = String(raw || '');
  // Strip a leading symbology identifier if the engine left it in.
  value = value.replace(/^\](C1|e0|d2|Q3|J1)/, '');
  // Bracketed human-readable form -> plain element string with separators.
  if (/^\(\d{2,4}\)/.test(value)) {
    value = value.replace(/\((\d{2,4})\)/g, function (m, ai) { return GS + ai; });
    if (value.charAt(0) === GS) value = value.slice(1);
  }
  value = value.replace(/^\x1d+/, '');

  var out = [], pos = 0, guard = 0;
  while (pos < value.length && guard++ < 100) {
    while (value.charAt(pos) === GS) pos++;
    if (pos >= value.length) break;
    var found = gs1Lookup(value, pos);
    if (!found) break;
    pos += found.ai.length;
    var data;
    if (found.len > 0) {
      data = value.substr(pos, found.len);
      pos += found.len;
    } else {
      var stop = value.indexOf(GS, pos);
      data = stop === -1 ? value.substr(pos) : value.substring(pos, stop);
      pos += data.length;
    }
    if (!data) break;
    var item = { ai: found.ai, label: found.label, value: data };
    if (found.decimals != null && /^\d+$/.test(data)) {
      var d = found.decimals;
      item.value = d ? (Number(data) / Math.pow(10, d)).toString() : String(Number(data));
    }
    if (/^(11|12|13|15|16|17)$/.test(found.ai) && /^\d{6}$/.test(data)) {
      var yy = Number(data.substr(0, 2)), mm = data.substr(2, 2), dd = data.substr(4, 2);
      var yyyy = yy >= 51 ? 1900 + yy : 2000 + yy;
      item.value = (dd === '00' ? '01' : dd) + '/' + mm + '/' + yyyy;
    }
    out.push(item);
  }
  return out;
}

function parseKeyValue(raw) {
  var value = String(raw || '').trim();
  var out = [];

  // JSON object
  if (/^\s*\{[\s\S]*\}\s*$/.test(value)) {
    try {
      var obj = JSON.parse(value);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (var k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          var v = obj[k];
          if (v == null || typeof v === 'object') continue;
          out.push({ ai: '', label: String(k), value: String(v) });
        }
        return out;
      }
    } catch (e) { /* not JSON after all */ }
  }

  // URL with query string
  if (/^https?:\/\//i.test(value) && value.indexOf('?') > 0) {
    var qs = value.slice(value.indexOf('?') + 1).split('#')[0];
    qs.split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq <= 0) return;
      try {
        out.push({
          ai: '', label: decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' ')),
          value: decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))
        });
      } catch (e) { /* skip malformed pair */ }
    });
    if (out.length) return out;
  }

  // key=value or key:value separated by newline, semicolon or pipe
  var parts = value.split(/[\n\r;|]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (parts.length) {
    var hits = 0;
    parts.forEach(function (p) {
      var m = p.match(/^([A-Za-z][A-Za-z0-9 _\-\/\.]{0,40})\s*[:=]\s*(.+)$/);
      if (!m) return;
      hits++;
      out.push({ ai: '', label: m[1].trim(), value: m[2].trim() });
    });
    // Only trust this shape if most segments actually parsed.
    if (hits && hits >= Math.ceil(parts.length / 2)) return out;
  }
  return [];
}

function parsePayload(raw, meta) {
  meta = meta || {};
  var value = String(raw == null ? '' : raw);
  var items = [];
  var kind = 'plain';

  if (meta.gs1 || looksLikeGS1(value, meta.symbology)) {
    items = parseGS1(value);
    if (items.length) kind = 'gs1';
  }
  if (!items.length) {
    items = parseKeyValue(value);
    if (items.length) kind = 'structured';
  }
  return {
    raw: value.replace(new RegExp(GS, 'g'), ' ').trim(),
    format: String(meta.format || ''),
    kind: kind,
    items: items
  };
}
/* PRS.AssetVerify — field mapper
 * Decides which decoded element goes into which form field.
 * Asset-tag AIs are ranked so a GIAI beats a GTIN beats an SSCC.
 */

var ASSET_TAG_AIS = { '8004': 100, '8003': 95, '8006': 70, '253': 65, '8013': 60, '01': 55, '02': 40, '00': 35 };
var SERIAL_AIS = { '21': 100, '8011': 80, '250': 70, '8019': 60 };
var QTY_AIS = { '30': 100, '37': 90 };

var LABEL_RULES = [
  ['assetName', /^(asset[\s_\-]*name|asset|item[\s_\-]*name|item|product|description|desc|particulars|equipment|machine)$/i],
  ['serialNumber', /^(serial[\s_\-]*(number|no|nu)?|s\/?n|sr[\s_\-]*no|serialnumber)$/i],
  ['quantity', /^(qty|quantity|count|nos|no[\s_\-]*of[\s_\-]*units|units|pcs|pieces)$/i],
  ['condition', /^(condition|cond|state|asset[\s_\-]*condition)$/i],
  ['verificationStatus', /^(status|verification[\s_\-]*status|found[\s_\-]*status|found)$/i],
  ['barcode', /^(barcode|bar[\s_\-]*code|qr|qr[\s_\-]*code|tag|asset[\s_\-]*tag|asset[\s_\-]*id|asset[\s_\-]*code|assetid|assetcode|code|id|uid)$/i]
];

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchFromList(value, list) {
  var want = normKey(value);
  if (!want) return '';
  for (var i = 0; i < list.length; i++) {
    if (normKey(list[i]) === want) return list[i];
  }
  for (var j = 0; j < list.length; j++) {
    if (normKey(list[j]).indexOf(want) === 0 || want.indexOf(normKey(list[j])) === 0) return list[j];
  }
  return '';
}

function cleanQty(value) {
  var n = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
  if (!isFinite(n) || n < 1) return '';
  return String(Math.min(n, 100000));
}

/* parsed  : output of parsePayload()
 * options : { conditions:[], statuses:[], fieldDefs:[{id,label}] }
 * returns : { asset:{...}, dynamic:{fieldId:value}, unmapped:[{label,value}] }
 */
function mapPayloadToFields(parsed, options) {
  options = options || {};
  var conditions = options.conditions || [];
  var statuses = options.statuses || [];
  var fieldDefs = options.fieldDefs || [];

  var asset = {}, dynamic = {}, unmapped = [];
  var tagRank = -1, serialRank = -1, qtyRank = -1;
  var items = (parsed && parsed.items) || [];

  function setDynamic(label, value) {
    for (var i = 0; i < fieldDefs.length; i++) {
      var def = fieldDefs[i];
      if (!def || !def.label) continue;
      if (normKey(def.label) === normKey(label)) {
        if (dynamic[def.id] == null) dynamic[def.id] = value;
        return true;
      }
    }
    return false;
  }

  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var val = String(it.value == null ? '' : it.value).trim();
    if (!val) continue;

    if (it.ai) {
      if (ASSET_TAG_AIS[it.ai] != null && ASSET_TAG_AIS[it.ai] > tagRank) {
        asset.barcode = val; tagRank = ASSET_TAG_AIS[it.ai]; continue;
      }
      if (SERIAL_AIS[it.ai] != null && SERIAL_AIS[it.ai] > serialRank) {
        asset.serialNumber = val; serialRank = SERIAL_AIS[it.ai]; continue;
      }
      if (QTY_AIS[it.ai] != null && QTY_AIS[it.ai] > qtyRank) {
        var q = cleanQty(val);
        if (q) { asset.quantity = q; qtyRank = QTY_AIS[it.ai]; continue; }
      }
      if (it.ai === '7021') {
        var c0 = matchFromList(val, conditions);
        if (c0) { asset.condition = c0; continue; }
      }
      if (setDynamic(it.label, val)) continue;
      unmapped.push({ label: '(' + it.ai + ') ' + it.label, value: val });
      continue;
    }

    var target = '';
    for (var r = 0; r < LABEL_RULES.length; r++) {
      if (LABEL_RULES[r][1].test(String(it.label || '').trim())) { target = LABEL_RULES[r][0]; break; }
    }

    if (target === 'quantity') {
      var q2 = cleanQty(val);
      if (q2 && qtyRank < 50) { asset.quantity = q2; qtyRank = 50; }
      continue;
    }
    if (target === 'condition') {
      var c = matchFromList(val, conditions);
      if (c) asset.condition = c; else unmapped.push({ label: it.label, value: val });
      continue;
    }
    if (target === 'verificationStatus') {
      var s = matchFromList(val, statuses);
      if (s) asset.verificationStatus = s; else unmapped.push({ label: it.label, value: val });
      continue;
    }
    if (target === 'barcode') {
      if (tagRank < 50) { asset.barcode = val; tagRank = 50; }
      continue;
    }
    if (target === 'serialNumber') {
      if (serialRank < 50) { asset.serialNumber = val; serialRank = 50; }
      continue;
    }
    if (target === 'assetName') { if (!asset.assetName) asset.assetName = val; continue; }

    if (setDynamic(it.label, val)) continue;
    unmapped.push({ label: it.label, value: val });
  }

  // A code with no internal structure is itself the asset tag. A structured
  // payload that simply had no tag key must NOT dump its whole body here.
  if (!asset.barcode && parsed && parsed.raw && (!items.length || parsed.kind === 'plain')) {
    asset.barcode = parsed.raw;
  }

  return { asset: asset, dynamic: dynamic, unmapped: unmapped };
}

/* Bridge to the shape app.js already consumes:
 * { raw, data, structured } feeding scanPayloadToAsset / scanDynamicValues. */
function payloadToData(raw, meta, options) {
  var parsed = parsePayload(raw, meta);
  var mapped = mapPayloadToFields(parsed, options || {});
  var a = mapped.asset, data = {};
  if (a.assetName) data.assetName = a.assetName;
  if (a.serialNumber) data.serialNumber = a.serialNumber;
  if (a.quantity) data.quantity = a.quantity;
  if (a.condition) data.condition = a.condition;
  if (a.verificationStatus) data.verificationStatus = a.verificationStatus;
  if (a.barcode) data.barcode = a.barcode;
  // Expose every element under its own label too, so dynamic sticky/variable
  // fields can be matched by label without a second parse.
  for (var i = 0; i < parsed.items.length; i++) {
    var it = parsed.items[i];
    if (it && it.label && data[it.label] == null) data[it.label] = it.value;
  }
  return {
    raw: parsed.raw, data: data, structured: parsed.kind !== 'plain',
    items: parsed.items, kind: parsed.kind, format: parsed.format
  };
}
/* PRS.AssetVerify — live scanner engine
 * Frames never block the UI thread: the main thread only grabs and downscales,
 * decoding happens in scan-worker.js. Native BarcodeDetector is tried first on
 * platforms that have it (Android/Chrome) because it is faster still; iOS has
 * no such API, so there the worker carries the whole load.
 */

var WORKER_URL = './scan-worker.js?v=300';

/* Symbologies that carry their own check character can be trusted on a single
 * read. The rest must be seen twice with the same value before we accept them,
 * because a misread there is silent. */
var SELF_CHECKING = /^(QRCode|MicroQRCode|rMQR|DataMatrix|Aztec|PDF417|MaxiCode|EAN-?13|EAN-?8|UPC-?A|UPC-?E|Code128|Code93|DataBar\w*|DXFilmEdge)$/i;

var FORMAT_SETS = {
  auto: [],
  code128: ['Code128'], gs1128: ['Code128'],
  code11: [], itf: ['ITF'], code39: ['Code39'], code39ext: ['Code39'],
  code93: ['Code93'], codabar: ['Codabar'],
  ean: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E'],
  databar: ['DataBar', 'DataBarExpanded', 'DataBarLimited'],
  qr: ['QRCode', 'MicroQRCode', 'rMQR'],
  datamatrix: ['DataMatrix'], aztec: ['Aztec'], pdf417: ['PDF417'],
  all2d: ['QRCode', 'MicroQRCode', 'rMQR', 'DataMatrix', 'Aztec', 'PDF417', 'MaxiCode'],
  msi: [], telepen: [], pharmacode1: [], pharmacode2: [], flattermarken: []
};

var NATIVE_FORMATS = ['qr_code', 'data_matrix', 'aztec', 'pdf417', 'code_128',
  'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e'];

var NATIVE_NAME = {
  qr_code: 'QRCode', data_matrix: 'DataMatrix', aztec: 'Aztec', pdf417: 'PDF417',
  code_128: 'Code128', code_39: 'Code39', code_93: 'Code93', codabar: 'Codabar',
  ean_13: 'EAN-13', ean_8: 'EAN-8', itf: 'ITF', upc_a: 'UPC-A', upc_e: 'UPC-E'
};

var S = {
  worker: null, workerReady: false, workerBusy: false, seq: 0, pending: null,
  native: null, nativeTried: false,
  stream: null, video: null, running: false,
  canvas: null, ctx: null,
  frames: 0, startedAt: 0, lastDispatch: 0,
  candidate: '', candidateHits: 0, candidateFormat: '',
  frameStamp: new Map(),
  mode: 'auto', onDecode: null, onStatus: null,
  lastLatencyMs: 0, torchOn: false, rvfcHandle: 0, timer: 0
};

function status(text, kind) {
  if (typeof S.onStatus === 'function') { try { S.onStatus(text, kind || 'info'); } catch (e) { } }
}

function ensureWorker() {
  if (S.worker) return S.worker;
  try {
    S.worker = new Worker(WORKER_URL);
  } catch (e) {
    S.worker = null;
    return null;
  }
  S.worker.onmessage = function (ev) {
    var m = ev.data || {};
    if (m.type === 'ready') { S.workerReady = !!m.ok; return; }
    if (m.type !== 'result') return;
    S.workerBusy = false;
    var t0 = S.frameStamp.get(m.id);
    S.frameStamp.delete(m.id);
    if (m.results && m.results.length) accept(m.results, t0);
  };
  S.worker.onerror = function () { S.workerBusy = false; S.workerReady = false; };
  return S.worker;
}

function warm() {
  var w = ensureWorker();
  if (w) { try { w.postMessage({ type: 'warm' }); } catch (e) { } }
  if (!S.nativeTried) {
    S.nativeTried = true;
    try {
      if (typeof self.BarcodeDetector === 'function') {
        self.BarcodeDetector.getSupportedFormats().then(function (list) {
          var use = NATIVE_FORMATS.filter(function (f) { return list.indexOf(f) >= 0; });
          if (use.length) S.native = new self.BarcodeDetector({ formats: use });
        }).catch(function () { });
      }
    } catch (e) { }
  }
}

function needsConfirm(format) { return !SELF_CHECKING.test(String(format || '')); }

function accept(results, t0) {
  if (!S.running) return;
  var best = results[0];
  for (var i = 0; i < results.length; i++) {
    if (String(results[i].format || '').toLowerCase().indexOf('qr') >= 0) { best = results[i]; break; }
  }
  var value = String(best.value || '').trim();
  if (!value) return;

  if (needsConfirm(best.format)) {
    if (S.candidate === value) {
      S.candidateHits++;
    } else {
      S.candidate = value; S.candidateHits = 1; S.candidateFormat = best.format;
      return;                                   // wait for a second identical read
    }
    if (S.candidateHits < 2) return;
  }

  S.lastLatencyMs = t0 ? Math.round(performance.now() - t0) : 0;
  S.running = false;
  stopLoop();
  if (typeof S.onDecode === 'function') {
    try { S.onDecode({ value: value, format: best.format, symbology: best.symbology, gs1: best.gs1, latencyMs: S.lastLatencyMs, engine: best.engine }); }
    catch (e) { }
  }
}

function grabFrame() {
  var v = S.video;
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  var vw = v.videoWidth, vh = v.videoHeight;
  // Full frame, no cropping: 1D symbols need their left/right quiet zones and a
  // QR can sit anywhere in view. Downscale only, and only if oversized.
  var target = 960;
  var scale = Math.min(1, target / Math.max(vw, vh));
  var w = Math.max(160, Math.round(vw * scale)), h = Math.max(120, Math.round(vh * scale));
  if (!S.canvas || S.canvas.width !== w || S.canvas.height !== h) {
    if (typeof OffscreenCanvas === 'function') {
      try { S.canvas = new OffscreenCanvas(w, h); } catch (e) { S.canvas = null; }
    }
    if (!S.canvas || S.canvas.width !== w) {
      S.canvas = document.createElement('canvas');
      S.canvas.width = w; S.canvas.height = h;
    } else { S.canvas.width = w; S.canvas.height = h; }
    S.ctx = S.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  }
  if (!S.ctx) return null;
  try {
    S.ctx.drawImage(v, 0, 0, w, h);
    return S.ctx.getImageData(0, 0, w, h);
  } catch (e) { return null; }
}

function dispatchFrame() {
  if (!S.running || S.workerBusy) return;
  var w = ensureWorker();
  if (!w) return;
  var img = grabFrame();
  if (!img) return;
  S.frames++;
  var id = ++S.seq;
  S.frameStamp.set(id, performance.now());
  if (S.frameStamp.size > 12) {
    var oldest = S.frameStamp.keys().next().value;
    S.frameStamp.delete(oldest);
  }
  S.workerBusy = true;
  var buf = img.data.buffer;
  var payload = {
    type: 'frame', id: id, buffer: buf, width: img.width, height: img.height,
    deep: (S.frames % 5 === 0),
    formats: FORMAT_SETS[S.mode] || [],
    code11: S.mode === 'code11' ? 'selected' : (S.mode === 'auto' && S.frames % 4 === 0 ? 'auto' : '')
  };
  try { w.postMessage(payload, [buf]); }
  catch (e) { S.workerBusy = false; }
}

async function nativePass() {
  if (!S.native || !S.running || !S.video) return false;
  var t0 = performance.now();
  try {
    var found = await S.native.detect(S.video);
    if (!found || !found.length) return false;
    var mapped = found.map(function (b) {
      return { value: String(b.rawValue || ''), format: NATIVE_NAME[b.format] || b.format, symbology: '', gs1: false, engine: 'native' };
    }).filter(function (b) { return b.value; });
    if (!mapped.length) return false;
    accept(mapped, t0);
    return true;
  } catch (e) { return false; }
}

function pump() {
  if (!S.running) return;
  nativePass().then(function (hit) {
    if (!hit && S.running) dispatchFrame();
  });
}

function startLoop() {
  var v = S.video;
  if (v && typeof v.requestVideoFrameCallback === 'function') {
    var step = function () {
      if (!S.running) return;
      pump();
      S.rvfcHandle = v.requestVideoFrameCallback(step);
    };
    S.rvfcHandle = v.requestVideoFrameCallback(step);
  } else {
    S.timer = setInterval(function () { if (S.running) pump(); }, 60);
  }
}

function stopLoop() {
  if (S.timer) { clearInterval(S.timer); S.timer = 0; }
  if (S.rvfcHandle && S.video && typeof S.video.cancelVideoFrameCallback === 'function') {
    try { S.video.cancelVideoFrameCallback(S.rvfcHandle); } catch (e) { }
  }
  S.rvfcHandle = 0;
}

async function tuneTrack(track) {
  if (!track || !track.getCapabilities) return;
  var caps = {};
  try { caps = track.getCapabilities() || {}; } catch (e) { return; }
  var advanced = [];
  if (Array.isArray(caps.focusMode) && caps.focusMode.indexOf('continuous') >= 0) advanced.push({ focusMode: 'continuous' });
  if (Array.isArray(caps.exposureMode) && caps.exposureMode.indexOf('continuous') >= 0) advanced.push({ exposureMode: 'continuous' });
  if (caps.zoom && caps.zoom.min <= 1.6 && caps.zoom.max >= 1.6) advanced.push({ zoom: Math.min(1.6, caps.zoom.max) });
  if (advanced.length) { try { await track.applyConstraints({ advanced: advanced }); } catch (e) { } }
}

async function toggleTorch(on) {
  var track = S.stream && S.stream.getVideoTracks && S.stream.getVideoTracks()[0];
  if (!track) return false;
  var caps = {};
  try { caps = track.getCapabilities ? (track.getCapabilities() || {}) : {}; } catch (e) { }
  if (!caps.torch) return false;
  try { await track.applyConstraints({ advanced: [{ torch: !!on }] }); S.torchOn = !!on; return true; }
  catch (e) { return false; }
}

function torchAvailable() {
  var track = S.stream && S.stream.getVideoTracks && S.stream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return false;
  try { return !!(track.getCapabilities() || {}).torch; } catch (e) { return false; }
}

async function start(opts) {
  opts = opts || {};
  S.onDecode = opts.onDecode || null;
  S.onStatus = opts.onStatus || null;
  S.mode = opts.mode || 'auto';
  S.video = opts.video || null;
  S.frames = 0; S.candidate = ''; S.candidateHits = 0; S.frameStamp.clear();
  S.workerBusy = false;

  if (!self.isSecureContext) throw new Error('Camera needs HTTPS.');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot open a live camera.');

  warm();

  var constraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 }, height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    }
  };
  var stream;
  try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
  catch (e) {
    if (String(e && e.name) === 'OverconstrainedError') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    } else if (String(e && e.name) === 'NotFoundError') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    } else throw e;
  }
  S.stream = stream;

  var v = S.video;
  v.srcObject = stream;
  v.muted = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.setAttribute('autoplay', '');
  try { var p = v.play(); if (p && p.catch) p.catch(function () { }); } catch (e) { }

  await new Promise(function (resolve, reject) {
    if (v.readyState >= 2 && v.videoWidth) { resolve(); return; }
    var done = false;
    var finish = function (ok) {
      if (done) return; done = true;
      clearTimeout(timer);
      v.removeEventListener('loadedmetadata', on);
      v.removeEventListener('canplay', on);
      ok ? resolve() : reject(new Error('Camera preview did not start.'));
    };
    var on = function () { if (v.videoWidth > 0) finish(true); };
    v.addEventListener('loadedmetadata', on);
    v.addEventListener('canplay', on);
    var timer = setTimeout(function () { finish(v.videoWidth > 0); }, 7000);
  });

  tuneTrack(stream.getVideoTracks()[0]).catch(function () { });
  S.running = true;
  S.startedAt = performance.now();
  startLoop();
  return true;
}

/* The camera deliberately stays open after a hit so the evidence photo can be
 * grabbed from the same frame. resume() restarts decoding if that fails. */
function resume() {
  if (!S.stream || !S.video) return false;
  S.candidate = ''; S.candidateHits = 0; S.workerBusy = false;
  S.running = true;
  startLoop();
  return true;
}

function stop() {
  S.running = false;
  stopLoop();
  if (S.stream && S.stream.getTracks) {
    S.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { } });
  }
  S.stream = null; S.torchOn = false;
  if (S.video) { try { S.video.pause(); } catch (e) { } try { S.video.srcObject = null; } catch (e) { } }
  S.candidate = ''; S.candidateHits = 0; S.frameStamp.clear();
  if (S.canvas) { try { S.canvas.width = 1; S.canvas.height = 1; } catch (e) { } S.canvas = null; S.ctx = null; }
}

/* Still-image decode, for the gallery / native-camera path. */
async function decodeImage(source, mode) {
  var w = ensureWorker();
  var img = await imageDataFrom(source);
  if (!img) return [];
  if (!w) return [];
  return await new Promise(function (resolve) {
    var id = ++S.seq, settled = false;
    var handler = function (ev) {
      var m = ev.data || {};
      if (m.type !== 'result' || m.id !== id) return;
      settled = true;
      w.removeEventListener('message', handler);
      resolve(m.results || []);
    };
    w.addEventListener('message', handler);
    var buf = img.data.buffer;
    try {
      w.postMessage({
        type: 'frame', id: id, buffer: buf, width: img.width, height: img.height,
        deep: true, formats: FORMAT_SETS[mode || 'auto'] || [],
        code11: (mode === 'code11') ? 'selected' : 'auto'
      }, [buf]);
    } catch (e) { w.removeEventListener('message', handler); resolve([]); return; }
    setTimeout(function () {
      if (settled) return;
      w.removeEventListener('message', handler);
      resolve([]);
    }, 9000);
  });
}

async function imageDataFrom(source) {
  try {
    var bitmap = null;
    if (typeof createImageBitmap === 'function' && (source instanceof Blob)) {
      bitmap = await createImageBitmap(source);
    }
    var w, h, drawable;
    if (bitmap) { w = bitmap.width; h = bitmap.height; drawable = bitmap; }
    else {
      var url = (source instanceof Blob) ? URL.createObjectURL(source) : source;
      var el = await new Promise(function (res, rej) {
        var im = new Image();
        im.onload = function () { res(im); };
        im.onerror = function () { rej(new Error('image load failed')); };
        im.src = url;
      });
      w = el.naturalWidth; h = el.naturalHeight; drawable = el;
      if (source instanceof Blob) setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    // Still photos keep more detail: allow up to 1600px for small dense codes.
    var scale = Math.min(1, 1600 / Math.max(w, h));
    var ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
    var c = document.createElement('canvas'); c.width = ow; c.height = oh;
    var ctx = c.getContext('2d', { willReadFrequently: true, alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ow, oh);
    ctx.drawImage(drawable, 0, 0, ow, oh);
    var out = ctx.getImageData(0, 0, ow, oh);
    c.width = 1; c.height = 1;
    if (bitmap && bitmap.close) bitmap.close();
    return out;
  } catch (e) { return null; }
}

self.PRSScan = {
  warm: warm,
  start: start,
  stop: stop,
  resume: resume,
  decodeImage: decodeImage,
  toggleTorch: toggleTorch,
  torchAvailable: torchAvailable,
  parsePayload: parsePayload,
  mapPayloadToFields: mapPayloadToFields,
  payloadToData: payloadToData,
  formatSets: FORMAT_SETS,
  state: S
};

})();
