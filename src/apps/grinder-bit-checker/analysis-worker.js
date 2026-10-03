/* Runs the curve analysis off the main thread so the page stays responsive. */
importScripts("analyze.js");

self.onmessage = function (e) {
  var d = e.data;
  try {
    var result = self.BitAnalyze.analyze({
      gray: d.gray, width: d.width, height: d.height, ppi: d.ppi, bits: d.bits,
      onProgress: function (message, fraction) {
        self.postMessage({ type: "progress", message: message, fraction: fraction });
      }
    });
    self.postMessage({ type: "done", spots: result.spots });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
