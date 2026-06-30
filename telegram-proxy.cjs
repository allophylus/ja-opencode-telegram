"use strict";
const http = require("http");
const https = require("https");
const net = require("net");
const IP = "149.154.166.110";
const HOST = "api.telegram.org";

function now() { return new Date().toISOString().slice(11, 19); }

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const methodPath = req.url.split("/").pop();
    console.log(`[${now()}] HTTP ${methodPath}`);
    const options = {
      hostname: IP, port: 443, path: req.url,
      servername: HOST, method: req.method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
        "Host": HOST
      },
      rejectUnauthorized: true,
      agent: false,
      timeout: 60000,
    };
    const proxyReq = https.request(options, (proxyRes) => {
      let data = "";
      proxyRes.on("data", (c) => (data += c));
      proxyRes.on("end", () => {
        res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, "connection": "close" });
        res.end(data);
        try { 
          const j = JSON.parse(data);
          console.log(`[${now()}]   <- HTTP ${methodPath}: ok=${j.ok}`);
        } catch(e) { console.log(`[${now()}]   <- HTTP ${methodPath}: ${proxyRes.statusCode}`); }
      });
    });
    proxyReq.on("error", (err) => {
      console.error(`[${now()}] HTTP ERR ${methodPath}: ${err.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end("err");
    });
    proxyReq.end(body);
  });
});

server.on("connect", (req, clientSocket, head) => {
  console.log(`[${now()}] CONNECT tunnel to ${req.url}`);
  const serverSocket = net.connect(443, IP, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on("error", (err) => {
    console.error(`[${now()}] CONNECT ERR: ${err.message}`);
    clientSocket.end();
  });
  clientSocket.on("error", () => serverSocket.end());
  clientSocket.on("close", () => { serverSocket.end(); console.log(`[${now()}] CONNECT client closed`); });
  serverSocket.on("close", () => { clientSocket.end(); console.log(`[${now()}] CONNECT server closed`); });
});

server.listen(8091, "127.0.0.1", () => console.log(`[${now()}] Proxy on 8091 (CONNECT+HTTP)`));
