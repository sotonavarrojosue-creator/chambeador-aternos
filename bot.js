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
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock');
const Vec3 = require('vec3');
const CONFIG = {
  host: 'sanfranblock.aternos.me',
  port: 38089,
  username: 'Chambeador',
  auth: 'offline',          // server cracked (sin premium/login)
  version: '1.21.11',       // última soportada por mineflayer (ViaVersion traduce)
  antiAfkIntervalo: 25000,  // ms entre "actividades"
  watchdogIntervalo: 20000, // ms entre chequeos de conexión real
};

let bot = null;
let esperandoServerOffline = false;
let ultimoSpawn = 0;
let antiAfkTimer = null;
let watchdogTimer = null;
let reconectando = false;
let minando = false;        // true mientras el bot mina (pausa el anti-AFK)
let minarVigiaTimer = null; // vigila la vida mientras mina

// ---- Estado real de la conexión ----
function conexionViva() {
  if (!bot) return false;
  try {
    // 1) debe haber entidad (spawn ocurrió)
    if (!bot.entity) return false;
    // 2) el socket TCP no debe estar destruido
    const socket = bot._client && bot._client.socket;
    if (socket && socket.destroyed) return false;
    // 3) no debe haber estado de cierre
    if (bot._client && bot._client.state === 'closed') return false;
    return true;
  } catch (e) {
    return false;
  }
}

// ---- Servidor HTTP: requerido por Render y para keep-alive (UptimeRobot) ----
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot: CONFIG.username,
    conectado: conexionViva(),
    spawnHace: ultimoSpawn ? Math.round((Date.now() - ultimoSpawn) / 1000) + 's' : 'nunca',
    server: `${CONFIG.host}:${CONFIG.port}`,
  }));
});
const HTTP_PORT = process.env.PORT || 3000;
server.listen(HTTP_PORT, () => {
  console.log(`[${hora()}] HTTP keep-alive en puerto ${HTTP_PORT}`);
});

function crearBot() {
  if (reconectando) return;
  console.log(`[${hora()}] Conectando como ${CONFIG.username} a ${CONFIG.host}:${CONFIG.port}...`);

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    auth: CONFIG.auth,
    version: CONFIG.version,
  });

  // Plugins: pathfinder (moverse) + collectblock (minar y recoger drops)
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock.plugin);

  bot.on('login', () => console.log(`[${hora()}] Login OK`));
  bot.on('spawn', () => {
    ultimoSpawn = Date.now();
    esperandoServerOffline = false;
    console.log(`[${hora()}] ✅ En el server. Bot activo (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
    // configurar pathfinder con los movimientos del bot
    try {
      const mcData = require('minecraft-data')(bot.version);
      bot.pathfinder.setMovements(new Movements(bot, mcData));
    } catch (e) {
      console.log(`[${hora()}] ⚠️ No se pudo configurar pathfinder: ${e.message}`);
    }
    arrancarAntiAfk();
    arrancarWatchdog();
    arrancarChat();
  });

  // ---- Anti-AFK: comportamiento humano aleatorio ----
  function arrancarAntiAfk() {
    if (antiAfkTimer) clearInterval(antiAfkTimer);
    antiAfkTimer = setInterval(() => {
      if (!conexionViva()) return;
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

  // ---- Comandos de chat: minería controlada por el usuario ----
  function arrancarChat() {
    bot.on('chat', (username, message) => {
      if (username === bot.username) return; // ignorar mensajes propios
      const args = message.trim().split(/\s+/);
      const cmd = args[0].toLowerCase();

      if (cmd === '!mina' && args.length >= 4) {
        const [x, y, z] = args.slice(1, 4).map(Number);
        if ([x, y, z].every(n => Number.isFinite(n))) minarBloque(x, y, z);
        else bot.chat('Uso: !mina <x> <y> <z>');
      } else if (cmd === '!minaarea' && args.length >= 7) {
        const nums = args.slice(1, 7).map(Number);
        if (nums.every(n => Number.isFinite(n))) minarArea(...nums);
        else bot.chat('Uso: !minaarea <x1> <y1> <z1> <x2> <y2> <z2>');
      } else if (cmd === '!stop') {
        pararMinado();
      } else if (cmd === '!ayuda' || cmd === '!help') {
        bot.chat('Comandos: !mina x y z | !minaarea x1 y1 z1 x2 y2 z2 | !stop');
      }
    });
  }

  // Pausar/reanudar anti-AFK (no debe caminar mientras mina)
  function pausarAntiAfk() {
    if (antiAfkTimer) { clearInterval(antiAfkTimer); antiAfkTimer = null; }
  }
  function reanudarAntiAfk() {
    if (!antiAfkTimer && conexionViva()) arrancarAntiAfk();
  }

  // Vigilar vida mientras mina: si baja de 3 corazones, parar
  function vigilarVida() {
    if (minarVigiaTimer) clearInterval(minarVigiaTimer);
    minarVigiaTimer = setInterval(() => {
      if (!minando) { clearInterval(minarVigiaTimer); minarVigiaTimer = null; return; }
      if (bot.health < 6) {
        try { bot.pathfinder.stop(); } catch (e) {}
        bot.chat('Me estoy muriendo, paro de minar');
        minando = false;
        clearInterval(minarVigiaTimer); minarVigiaTimer = null;
        reanudarAntiAfk();
      }
    }, 3000);
  }

  // Mina UN bloque en coordenadas
  async function minarBloque(x, y, z) {
    if (!conexionViva()) return;
    if (minando) { bot.chat('Ya estoy minando, usa !stop primero'); return; }
    minando = true;
    pausarAntiAfk();
    vigilarVida();
    bot.chat(`Voy a minar ${x} ${y} ${z}`);
    try {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (!block || block.name === 'air') {
        bot.chat('Ese bloque no existe o es aire');
        minando = false; reanudarAntiAfk(); return;
      }
      // acercarse al bloque
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
      // minarlo y recoger el drop
      await bot.collectBlock.collect([block]);
      bot.chat(`Listo, miné ${block.name}`);
    } catch (e) {
      bot.chat(`No pude minar: ${(e.message || e).slice(0, 60)}`);
    }
    minando = false;
    reanudarAntiAfk();
  }

  // Mina TODO el volumen entre dos esquinas (estilo WorldEdit):
  // genera todas las posiciones del cubo y va picando capa por capa.
  async function minarArea(x1, y1, z1, x2, y2, z2) {
    if (!conexionViva()) return;
    if (minando) { bot.chat('Ya estoy minando, usa !stop primero'); return; }

    const [minX, maxX] = [Math.min(x1, x2), Math.max(x1, x2)];
    const [minY, maxY] = [Math.min(y1, y2), Math.max(y1, y2)];
    const [minZ, maxZ] = [Math.min(z1, z2), Math.max(z1, z2)];
    const volumen = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (volumen > 200000) {
      bot.chat(`Área demasiado grande (${volumen} bloques). Máximo 200.000`);
      return;
    }

    minando = true;
    pausarAntiAfk();
    vigilarVida();
    bot.chat(`Minando cubo ${minX},${minY},${minZ} → ${maxX},${maxY},${maxZ} (${volumen} bloques de volumen)`);

    try {
      // ir al centro del cubo para forzar la carga de chunks
      const centro = new Vec3((minX + maxX) >> 1, (minY + maxY) >> 1, (minZ + maxZ) >> 1);
      await bot.pathfinder.goto(new goals.GoalBlock(centro.x, centro.y, centro.z));
      await new Promise(r => setTimeout(r, 3000)); // esperar a que carguen los chunks

      // generar TODAS las posiciones del cubo, capa por capa.
      // IMPORTANTE: Y de ARRIBA hacia ABAJO — si se mina de abajo hacia arriba,
      // el bloque de encima cae sobre el bot y lo deja atrapado.
      const posiciones = [];
      for (let y = maxY; y >= minY; y--) {
        for (let z = minZ; z <= maxZ; z++) {
          for (let x = minX; x <= maxX; x++) {
            posiciones.push(new Vec3(x, y, z));
          }
        }
      }

      // filtrar solo bloques reales (aire, agua, lava y bedrock no se minan)
      const bloques = [];
      for (const pos of posiciones) {
        const b = bot.blockAt(pos);
        if (b && !['air', 'cave_air', 'void_air', 'water', 'lava', 'bedrock'].includes(b.name)) {
          bloques.push(b);
        }
      }

      if (bloques.length === 0) {
        bot.chat('No hay bloques minables en esa área');
        minando = false; reanudarAntiAfk(); return;
      }

      bot.chat(`Encontré ${bloques.length} bloques minables. Picando...`);
      // por cada bloque: si está al alcance, dig directo (sin pathfinder, evita
      // el bug "Took to long to decide path"); si está lejos, acercarse y dig.
      // Si uno falla, sigue con el siguiente.
      const ALCANCE = 4.5; // distancia de dig en Minecraft
      let minados = 0;
      for (let i = 0; i < bloques.length && minando && conexionViva(); i++) {
        const block = bloques[i];
        try {
          const dist = bot.entity.position.distanceTo(block.position);
          if (dist > ALCANCE) {
            try {
              await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3));
            } catch (e) {
              // si no puede calcular ruta, intentar dig directo igualmente
            }
          }
          // dig con reintentos (el bot puede moverse/caer durante el dig → "Digging aborted")
          let exito = false;
          for (let intento = 0; intento < 3 && !exito; intento++) {
            try {
              await bot.dig(block);
              exito = true;
            } catch (e) {
              await new Promise(r => setTimeout(r, 500));
            }
          }
          if (!exito) throw new Error('dig falló 3 veces');
          minados++;
          // si quedó atrapado (bloque cayó encima), saltar para liberarse
          const bloqueEnMi = bot.blockAt(bot.entity.position);
          if (bloqueEnMi && bloqueEnMi.name !== 'air') {
            bot.setControlState('jump', true);
            await new Promise(r => setTimeout(r, 600));
            bot.setControlState('jump', false);
          }
        } catch (e) {
          console.log(`[${hora()}] Bloque ${i} falló: ${e.message.slice(0, 50)}`);
        }
        // recoger drops acumulados cada 10 bloques
        if (minados > 0 && minados % 10 === 0) {
          try { await bot.collectBlock.collectNearby(8); } catch (e) {}
          bot.chat(`Progreso: ${minados}/${bloques.length} bloques minados`);
        }
      }
      // recoger drops restantes al terminar
      try { await bot.collectBlock.collectNearby(16); } catch (e) {}

      if (minando) bot.chat(`Área minada: ${minados}/${bloques.length} bloques. Listo!`);
      else bot.chat(`Detenido con ${minados}/${bloques.length} bloques minados`);
    } catch (e) {
      bot.chat(`Minado interrumpido: ${(e.message || e).slice(0, 60)}`);
    }
    minando = false;
    reanudarAntiAfk();
  }

  function pararMinado() {
    if (!minando) { bot.chat('No estoy minando'); return; }
    try { bot.pathfinder.stop(); } catch (e) {}
    minando = false;
    if (minarVigiaTimer) { clearInterval(minarVigiaTimer); minarVigiaTimer = null; }
    reanudarAntiAfk();
    bot.chat('Parado.');
  }

  // ---- Watchdog: detecta conexiones muertas silenciosamente ----
  function arrancarWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (!conexionViva()) {
        console.log(`[${hora()}] ⚠️ Watchdog: conexión muerta detectada (entity=${!!bot.entity}, socket=${bot._client && bot._client.socket ? !bot._client.socket.destroyed : 'n/a'})`);
        reconectar();
      }
    }, CONFIG.watchdogIntervalo);
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
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') esperandoServerOffline = true;
  });
}

function reconectar() {
  if (reconectando) return;
  reconectando = true;

  // limpiar timers
  if (antiAfkTimer) { clearInterval(antiAfkTimer); antiAfkTimer = null; }
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (minarVigiaTimer) { clearInterval(minarVigiaTimer); minarVigiaTimer = null; }
  minando = false;

  // cerrar bot viejo si sigue vivo
  if (bot) {
    try { bot.removeAllListeners(); bot.end(); } catch (e) {}
    bot = null;
  }

  const delay = esperandoServerOffline ? 60000 : 5000;
  console.log(`[${hora()}] Reintentando en ${delay / 1000}s...${esperandoServerOffline ? ' (server apagado — Aternos lo enciende al conectar)' : ''}`);
  setTimeout(() => {
    reconectando = false;
    crearBot();
  }, delay);
}

function hora() {
  return new Date().toLocaleTimeString('es-MX', { hour12: false });
}

console.log('==========================================');
console.log('  Chambeador — Bot Aternos 24/7');
console.log('  Ctrl+C para detener');
console.log('==========================================');
crearBot();