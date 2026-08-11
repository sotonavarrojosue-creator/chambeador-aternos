#!/usr/bin/env node
/**
 * Chambeador — Bot 24/7 para Aternos (sanfranblock)
 * Mantiene el server online moviéndose como un jugador real.
 *
 * Requisito: el server de Aternos debe tener instalados los plugins
 * ViaVersion + ViaBackwards (el server es MC 26.2 y mineflayer soporta
 * hasta 1.21.11 — esos plugins traducen el protocolo).
 *
 * Uso: node bot.js
 */

const mineflayer = require('mineflayer');
const http = require('http');

const CONFIG = {
  host: 'sanfranblock.aternos.me',
  port: 38089,
  username: 'Chambeador',
  auth: 'offline',          // server cracked (sin premium/login)
  version: '1.21.11',       // última soportada por mineflayer (ViaVersion traduce)
  antiAfkIntervalo: 25000,  // ms entre "actividades"
};

// ---- Servidor HTTP: requerido por Render y para keep-alive (UptimeRobot) ----
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot: CONFIG.username,
    conectado: !!(bot && bot.entity),
    server: `${CONFIG.host}:${CONFIG.port}`,
  }));
});
const HTTP_PORT = process.env.PORT || 3000;
server.listen(HTTP_PORT, () => {
  console.log(`[${hora()}] HTTP keep-alive en puerto ${HTTP_PORT}`);
});

let bot = null;
let esperandoServerOffline = false;

function crearBot() {
  console.log(`[${hora()}] Conectando como ${CONFIG.username} a ${CONFIG.host}:${CONFIG.port}...`);

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    auth: CONFIG.auth,
    version: CONFIG.version,
  });

  bot.on('login', () => console.log(`[${hora()}] Login OK`));
  bot.on('spawn', () => {
    console.log(`[${hora()}] ✅ En el server. Bot activo (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
    esperandoServerOffline = false;
    arrancarAntiAfk();
  });

  // ---- Anti-AFK: comportamiento humano aleatorio ----
  function arrancarAntiAfk() {
    setInterval(async () => {
      if (!bot || !bot.entity) return;
      try {
        // 1) saltar
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 400);

        // 2) caminar 1-3 segundos en dirección aleatoria
        const dir = ['forward', 'back', 'left', 'right'][Math.floor(Math.random() * 4)];
        bot.setControlState(dir, true);
        setTimeout(() => bot.setControlState(dir, false), 1000 + Math.random() * 2000);

        // 3) girar la cabeza de vez en cuando
        if (Math.random() < 0.5) {
          bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5);
        }

        // 4) mandar un mensaje inofensivo cada ~5 min para parecer activo
        if (Math.random() < 0.01) {
          const msg = ['gg', 'hola', ':', 'buenas', 'xdxd'][Math.floor(Math.random() * 5)];
          bot.chat(msg);
        }
      } catch (e) { /* ignorar errores momentáneos */ }
    }, CONFIG.antiAfkIntervalo);
  }

  // ---- Eventos de desconexión ----
  bot.on('kicked', (reason) => {
    console.log(`[${hora()}] ⚠️ Kickeado: ${reason}`);
    reconectar();
  });
  bot.on('end', (reason) => {
    console.log(`[${hora()}] ⚠️ Desconectado: ${reason || 'fin de conexión'}`);
    reconectar();
  });
  bot.on('error', (err) => {
    console.log(`[${hora()}] ⚠️ Error: ${err.message}`);
    // "ECONNREFUSED" = server apagado (típico de Aternos)
    if (err.code === 'ECONNREFUSED') esperandoServerOffline = true;
  });
}

function reconectar() {
  // cerrar bot viejo si sigue vivo
  if (bot) { try { bot.removeAllListeners(); bot.end(); } catch (e) {} bot = null; }

  const delay = esperandoServerOffline ? 60000 : 5000;
  console.log(`[${hora()}] Reintentando en ${delay / 1000}s...${esperandoServerOffline ? ' (server apagado — enciéndelo en el panel de Aternos)' : ''}`);
  setTimeout(crearBot, delay);
}

function hora() {
  return new Date().toLocaleTimeString('es-MX', { hour12: false });
}

console.log('==========================================');
console.log('  Chambeador — Bot Aternos 24/7');
console.log('  Ctrl+C para detener');
console.log('==========================================');
crearBot();
