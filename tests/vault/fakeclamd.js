const net = require("net");
net.createServer(sock => {
  let buf = Buffer.alloc(0), started = false, data = [];
  sock.on("data", d => {
    buf = Buffer.concat([buf, d]);
    if (!started) { const i = buf.indexOf(0); if (i < 0) return; buf = buf.subarray(i + 1); started = true; }
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0);
      if (n === 0) { const all = Buffer.concat(data).toString("latin1"); sock.end(all.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0"); return; }
      if (buf.length < 4 + n) return;
      data.push(buf.subarray(4, 4 + n)); buf = buf.subarray(4 + n);
    }
  });
}).listen(3310, () => console.log("fake clamd on 3310"));
