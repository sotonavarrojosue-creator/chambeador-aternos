#!/usr/bin/env node
/**
 * Chambeador — Bot 24/7 para Aternos (sanfranblock)
 * Mantiene el server online moviéndose como un jugador real + minería
 * controlada por chat (estilo WorldEdit).
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
const toolPlugin = require('mineflayer-tool');
const Vec3 = require('vec3');

const CONFIG = {
  host: 'sanfranblock.aternos.me',
  port: 38089,
  username: 'Chambeador',
  auth: 'offline',          // server cracked (sin premium/login)
  version: '1.21.11',       // última soportada por mineflayer (ViaVersion traduce)
  antiAfkIntervalo: 25000,  // ms entre "actividades"
  watchdogIntervalo: 20000, // ms entre chequeos de conexión real
  alcanceDig: 4.5,          // distancia de dig en Minecraft
};

// Bloques que no se minan nunca
const NO_MINABLES = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'bedrock']);
// Basura que se dropea cuando el inventario está lleno
const BASURA = new Set(['dirt', 'stone', 'cobblestone', 'gravel', 'sand', 'grass_block', 'short_grass', 'tall_grass', 'pink_petals', 'dandelion', 'poppy', 'azure_bluet', 'allium', 'cornflower', 'oxeye_daisy', 'wheat_seeds']);

let bot = null;
let esperandoServerOffline = false;
let ultimoSpawn = 0;
let antiAfkTimer = null;
let watchdogTimer = null;
let reconectando = false;
let minando = false;        // true mientras el bot mina (pausa el anti-AFK)
let minarVigiaTimer = null; // vigila la vida mientras mina
let siguiendoA = null;      // username al que el bot sigue (!ven)
let seguirTimer = null;     // timer de seguimiento
let seleccion = { pos1: null, pos2: null }; // selección estilo WorldEdit (!pos1 / !pos2)

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
    // 4) la posición no debe ser NaN (desync raro)
    const p = bot.entity.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
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
    minando,
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

  // Plugins: pathfinder (moverse) + collectblock (minar/recoger) + tool (mejor pico)
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlock.plugin);
  bot.loadPlugin(toolPlugin.plugin);

  bot.on('login', () => console.log(`[${hora()}] Login OK`));
  bot.on('spawn', () => {
    ultimoSpawn = Date.now();
    esperandoServerOffline = false;
    console.log(`[${hora()}] ✅ En el server. Bot activo (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
    // configurar pathfinder con movimientos optimizados:
    // canDig=false → el pathfinder NO rompe bloques extra (evita destrozar el cubo)
    // allow1by1towers=false → no construye torres raras
    try {
      const mcData = require('minecraft-data')(bot.version);
      const movements = new Movements(bot, mcData);
      movements.canDig = false;
      movements.allow1by1towers = false;
      bot.pathfinder.setMovements(movements);
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
      if (!conexionViva() || minando || siguiendoA) return;
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
  // IMPORTANTE: el server formatea el chat de forma custom (plugin SuperLobby)
  // con prefijos de grupo: "[Not Secure] <[OWNER] TyllinROCK> !pos1"
  // Por eso el evento estándar 'chat' de mineflayer NO se dispara — usamos
  // 'message' y parseamos <jugador> mensaje manualmente.
  function limpiarNombre(username) {
    return (username || '').replace(/^\[.*?\]\s*/, '').trim();
  }

  function procesarComando(username, mensaje) {
    const nombreLimpio = limpiarNombre(username);
    if (!nombreLimpio || nombreLimpio === bot.username) return; // ignorar propios/vacíos
    // normalizar: acepta !pos1, /pos1 y //pos1 (WorldEdit style)
    const args = mensaje.trim().replace(/^\/+/, '').split(/\s+/);
    const cmd = args[0].toLowerCase();
    console.log(`[${hora()}] 💬 Comando de ${nombreLimpio}: ${mensaje}`);

    if (cmd === '!mina' && args.length >= 4) {
      const [x, y, z] = args.slice(1, 4).map(Number);
      if ([x, y, z].every(n => Number.isFinite(n))) minarBloque(x, y, z);
      else bot.chat('Uso: !mina <x> <y> <z>');
    } else if (cmd === '!minaarea' && args.length >= 7) {
      const nums = args.slice(1, 7).map(Number);
      if (nums.every(n => Number.isFinite(n))) minarArea(...nums);
      else bot.chat('Uso: !minaarea <x1> <y1> <z1> <x2> <y2> <z2>');
    } else if (cmd === '!minaveta' && args.length >= 4) {
      const [x, y, z] = args.slice(1, 4).map(Number);
      if ([x, y, z].every(n => Number.isFinite(n))) minarVeta(x, y, z);
      else bot.chat('Uso: !minaveta <x> <y> <z>');
    } else if (cmd === '!diamantes') {
      minarMineral('diamond_ore');
    } else if (cmd === '!hierro') {
      minarMineral('iron_ore');
    } else if (cmd === '!oro') {
      minarMineral('gold_ore');
    } else if (cmd === '!ven' && args.length >= 2) {
      seguirJugador(limpiarNombre(args[1]));
    } else if (cmd === '!vuelve') {
      volverAlSpawn();
      } else if (cmd === '!inventario') {
        listarInventario();
      } else if (cmd === '!pico') {
        damePico(args[1]);
      } else if (cmd === '!recoge') {
        recogerTodo();
      } else if (cmd === '!donde') {
        const p = bot.entity ? bot.entity.position : null;
        bot.chat(p ? `Estoy en ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} (mírame y usa !ven)` : 'No tengo posición');
      } else if (cmd === '!pos1') {
      marcarPos(1, nombreLimpio);
    } else if (cmd === '!pos2') {
      marcarPos(2, nombreLimpio);
    } else if (cmd === '!sel') {
      mostrarSeleccion();
    } else if (cmd === '!minar') {
      minarSeleccion();
    } else if (cmd === '!limpiar') {
      seleccion = { pos1: null, pos2: null };
      bot.chat('Selección borrada');
    } else if (cmd === '!stop') {
      pararMinado();
    } else if (cmd === '!ayuda' || cmd === '!help') {
      bot.chat('Comandos: !pos1 | !pos2 | !minar | !sel | !limpiar | !mina x y z | !minaarea x1 y1 z1 x2 y2 z2 | !minaveta x y z | !diamantes | !hierro | !oro | !ven <jugador> | !vuelve | !inventario | !stop');
    }
  }

  function arrancarChat() {
    // El server manda el chat con formato custom (translate "%s" + campo
    // "unsigned"): toString() devuelve SOLO el mensaje sin nombre, y el evento
    // 'chat' de mineflayer NO se dispara. Por eso:
    // 1) solo procesamos mensajes que empiezan con ! o /
    // 2) el nombre del jugador se extrae del JSON "unsigned"
    bot.on('message', (jsonMsg) => {
      try {
        const texto = jsonMsg.toString();
        const trimmed = texto.trim();
        if (!trimmed.startsWith('!') && !trimmed.startsWith('/')) return; // solo comandos
        const nombre = extraerNombreMensaje(jsonMsg) || 'desconocido';
        procesarComando(nombre, trimmed);
      } catch (e) { /* ignorar */ }
    });
  }

  // Extrae el nombre del jugador del JSON unsigned del mensaje
  // ("[OWNER]TyllinROCK" → "TyllinROCK")
  function extraerNombreMensaje(jsonMsg) {
    try {
      const u = jsonMsg.unsigned || jsonMsg;
      const withs = (u.json && u.json.with) || [];
      if (withs.length === 0) return null;
      const primer = withs[0];
      if (primer && primer.extra) {
        const primerExtra = primer.extra[0];
        if (primerExtra && primerExtra.extra) {
          return limpiarNombre(primerExtra.extra.map(e => e.text || '').join(''));
        }
        if (primerExtra && primerExtra.text) {
          return limpiarNombre(primerExtra.text);
        }
      }
      if (primer && primer.text) {
        return limpiarNombre(primer.text);
      }
    } catch (e) { /* ignorar */ }
    return null;
  }

  // ---- Selección estilo WorldEdit: bloque que el jugador está mirando ----
  function bloqueQueMira(username) {
    const jugador = bot.players[username] && bot.players[username].entity;
    if (!jugador) return { ok: false, razon: `No te veo (${username}), acércate al bot o usa !donde` };
    try {
      const pos = jugador.position;
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        return { ok: false, razon: 'Tu posición aún no está cargada' };
      }
      const ojo = pos.offset(0, 1.62, 0); // altura de los ojos
      // dirección de mirada calculada manualmente (lookVector del getter falla en este server)
      const dir = new Vec3(
        -Math.sin(jugador.yaw) * Math.cos(jugador.pitch),
        -Math.sin(jugador.pitch),
        -Math.cos(jugador.yaw) * Math.cos(jugador.pitch)
      );
      const hit = bot.world.raycast(ojo, dir, 64, (block) => block && !NO_MINABLES.has(block.name));
      if (!hit) return { ok: false, razon: 'No veo un bloque en tu línea de mira (apunta a un bloque cercano)' };
      return { ok: true, pos: hit.position };
    } catch (e) {
      console.log(`[${hora()}] ⚠️ Error raycast: ${e.message}`);
      return { ok: false, razon: 'Error calculando tu mirada' };
    }
  }

  function marcarPos(n, username) {
    const res = bloqueQueMira(username);
    if (!res.ok) {
      bot.chat(res.razon);
      return;
    }
    seleccion[n === 1 ? 'pos1' : 'pos2'] = res.pos;
    bot.chat(`Pos${n} marcada: ${res.pos.x} ${res.pos.y} ${res.pos.z}`);
  }

  function mostrarSeleccion() {
    const p1 = seleccion.pos1, p2 = seleccion.pos2;
    if (!p1 && !p2) { bot.chat('Selección vacía. Usa !pos1 y !pos2 mirando los bloques'); return; }
    bot.chat(`Pos1: ${p1 ? `${p1.x} ${p1.y} ${p1.z}` : '—'} | Pos2: ${p2 ? `${p2.x} ${p2.y} ${p2.z}` : '—'}`);
  }

  function minarSeleccion() {
    const p1 = seleccion.pos1, p2 = seleccion.pos2;
    if (!p1 || !p2) {
      bot.chat('Necesitas marcar !pos1 y !pos2 primero');
      return;
    }
    minarArea(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
  }

  // Pausar/reanudar anti-AFK (no debe caminar mientras mina)
  function pausarAntiAfk() {
    if (antiAfkTimer) { clearInterval(antiAfkTimer); antiAfkTimer = null; }
  }
  function reanudarAntiAfk() {
    if (!antiAfkTimer && conexionViva() && !siguiendoA) arrancarAntiAfk();
  }

  // ---- Recoger drops (items) cercanos del suelo ----
  async function recogerDropsCercanos(distancia) {
    try {
      const drops = Object.values(bot.entities).filter(e =>
        e.type === 'object' && e.objectType === 'Item' &&
        bot.entity.position.distanceTo(e.position) < distancia
      );
      if (drops.length > 0) {
        await bot.collectBlock.collect(drops, { ignoreNoPath: true });
      }
    } catch (e) { /* ignorar */ }
  }

  // ---- Gestión de inventario: si está casi lleno, dropear basura ----
  function gestionarInventario() {
    if (!bot.inventory) return;
    const slots = bot.inventory.slots();
    const vacios = slots.filter(s => !s).length;
    if (vacios < 5) {
      for (const slot of slots) {
        if (!slot) continue;
        if (BASURA.has(slot.name)) {
          try { bot.tossStack(slot); } catch (e) {}
          return true;
        }
      }
      bot.chat('Inventario lleno y sin basura que dropear');
      return true;
    }
    return false;
  }

  // ---- Vigilar vida/hambre/peligro mientras mina ----
  function vigilarVida() {
    if (minarVigiaTimer) clearInterval(minarVigiaTimer);
    minarVigiaTimer = setInterval(() => {
      if (!minando) { clearInterval(minarVigiaTimer); minarVigiaTimer = null; return; }
      // vida < 3 corazones o hambre < 3
      if (bot.health < 6 || bot.food < 6) {
        try { bot.pathfinder.stop(); } catch (e) {}
        bot.chat('Me estoy muriendo o tengo hambre, paro de minar');
        minando = false;
        clearInterval(minarVigiaTimer); minarVigiaTimer = null;
        reanudarAntiAfk();
        return;
      }
      // si está dentro de lava o agua, saltar para salir
      const bloqueEnMi = bot.blockAt(bot.entity.position);
      if (bloqueEnMi && (bloqueEnMi.name === 'lava' || bloqueEnMi.name === 'water')) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 800);
      }
    }, 3000);
  }

  // ---- Equipar el mejor pico para un bloque (mineflayer-tool) ----
  async function equiparMejorPico(block) {
    try {
      await bot.tool.equipForBlock(block);
    } catch (e) { /* sin pico: mina a mano */ }
  }

  // ---- Mina UN bloque en coordenadas ----
  async function minarBloque(x, y, z) {
    if (!conexionViva()) return;
    if (minando) { bot.chat('Ya estoy minando, usa !stop primero'); return; }
    minando = true;
    pausarAntiAfk();
    vigilarVida();
    bot.chat(`Voy a minar ${x} ${y} ${z}`);
    try {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (!block || NO_MINABLES.has(block.name)) {
        bot.chat('Ese bloque no existe o no es minable');
        minando = false; reanudarAntiAfk(); return;
      }
      await equiparMejorPico(block);
      // GoalLookAtBlock: se posiciona mirando la cara del bloque (más fiable que GoalNear)
      await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world, { reach: CONFIG.alcanceDig }));
      await bot.dig(block);
      bot.chat(`Listo, miné ${block.name}`);
    } catch (e) {
      bot.chat(`No pude minar: ${(e.message || e).slice(0, 60)}`);
    }
    minando = false;
    reanudarAntiAfk();
  }

  // ---- Mina una VETA completa (flood-fill del mismo tipo de bloque) ----
  async function minarVeta(x, y, z) {
    if (!conexionViva()) return;
    if (minando) { bot.chat('Ya estoy minando, usa !stop primero'); return; }
    minando = true;
    pausarAntiAfk();
    vigilarVida();
    bot.chat(`Buscando veta en ${x} ${y} ${z}...`);
    try {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (!block || NO_MINABLES.has(block.name)) {
        bot.chat('Ese bloque no existe o no es minable');
        minando = false; reanudarAntiAfk(); return;
      }
      // flood-fill: todos los bloques conectados del mismo tipo
      const veta = bot.collectBlock.findFromVein(block);
      if (veta.length === 0) {
        bot.chat('No encontré veta');
        minando = false; reanudarAntiAfk(); return;
      }
      bot.chat(`Veta de ${block.name}: ${veta.length} bloques. Picando...`);
      await bot.collectBlock.collect(veta, { ignoreNoPath: true });
      bot.chat(`Veta minada: ${veta.length} bloques. Listo!`);
    } catch (e) {
      bot.chat(`Veta interrumpida: ${(e.message || e).slice(0, 60)}`);
    }
    minando = false;
    reanudarAntiAfk();
  }

  // ---- Mina minerales cercanos (diamantes, hierro, oro...) ----
  async function minarMineral(tipo) {
    if (!conexionViva()) return;
    if (minando) { bot.chat('Ya estoy minando, usa !stop primero'); return; }
    minando = true;
    pausarAntiAfk();
    vigilarVida();
    bot.chat(`Buscando ${tipo.replace('_ore', '')} cerca...`);
    try {
      const posiciones = bot.findBlocks({
        matching: b => b && b.name === tipo,
        maxDistance: 64,
        count: 20,
      });
      if (posiciones.length === 0) {
        bot.chat(`No veo ${tipo.replace('_ore', '')} cerca (radio 64)`);
        minando = false; reanudarAntiAfk(); return;
      }
      const bloques = posiciones.map(p => bot.blockAt(p)).filter(b => b);
      bot.chat(`Encontré ${bloques.length} ${tipo.replace('_ore', '')}. Picando...`);
      await bot.collectBlock.collect(bloques, { ignoreNoPath: true });
      bot.chat(`Listo, miné ${bloques.length} ${tipo.replace('_ore', '')}`);
    } catch (e) {
      bot.chat(`Minado interrumpido: ${(e.message || e).slice(0, 60)}`);
    }
    minando = false;
    reanudarAntiAfk();
  }

  // ---- Seguir a un jugador (!ven) ----
  function seguirJugador(username) {
    if (!conexionViva()) return;
    if (minando) { bot.chat('Estoy minando, usa !stop primero'); return; }
    siguiendoA = username;
    pausarAntiAfk();
    bot.chat(`Te sigo, ${username}. !stop para parar`);
    if (seguirTimer) clearInterval(seguirTimer);
    seguirTimer = setInterval(async () => {
      if (!conexionViva() || !siguiendoA) { clearInterval(seguirTimer); seguirTimer = null; return; }
      const jugador = bot.players[siguiendoA] && bot.players[siguiendoA].entity;
      if (!jugador) return;
      try {
        await bot.pathfinder.goto(new goals.GoalNear(jugador.position.x, jugador.position.y, jugador.position.z, 2));
      } catch (e) { /* reintenta en el siguiente tick */ }
    }, 3000);
  }

  // ---- Volver al spawn (!vuelve) ----
  async function volverAlSpawn() {
    if (!conexionViva()) return;
    if (minando) { bot.chat('Estoy minando, usa !stop primero'); return; }
    if (!bot.spawnPoint) { bot.chat('No sé dónde está el spawn'); return; }
    bot.chat('Volviendo al spawn...');
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(bot.spawnPoint.x, bot.spawnPoint.y, bot.spawnPoint.z));
      bot.chat('Llegué al spawn');
    } catch (e) {
      bot.chat(`No pude volver: ${(e.message || e).slice(0, 60)}`);
    }
  }

  // ---- Listar inventario (!inventario) ----
  function listarInventario() {
    if (!conexionViva()) return;
    const items = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ');
    bot.chat(`Inventario: ${items || 'vacío'}`);
  }

  // ---- Darse un pico a sí mismo (!pico [tipo]) — el bot es OP ----
  const PICOS = {
    diamante: 'diamond_pickaxe',
    hierro: 'iron_pickaxe',
    piedra: 'stone_pickaxe',
    madera: 'wooden_pickaxe',
  };
  function damePico(tipo) {
    if (!conexionViva()) return;
    const pico = PICOS[(tipo || 'hierro').toLowerCase()] || PICOS.hierro;
    bot.chat(`Intentando conseguir ${pico}...`);
    bot.chat(`/give ${bot.username} ${pico} 1`);
    // verificar si lo recibió
    setTimeout(() => {
      const loTiene = bot.inventory.items().some(i => i.name === pico);
      if (loTiene) {
        bot.chat(`✅ Tengo ${pico}. Ya lo equipo solo al minar`);
        // equiparlo ya
        try { bot.equip(bot.inventory.items().find(i => i.name === pico), 'hand'); } catch (e) {}
      } else {
        bot.chat('No me llegó el pico (¿tengo permisos de OP?). Si no, tíramelo y usa !recoge');
      }
    }, 2500);
  }

  // ---- Recoger todos los drops cercanos (!recoge) ----
  async function recogerTodo() {
    if (!conexionViva()) return;
    bot.chat('Recogiendo items cercanos...');
    await recogerDropsCercanos(32);
    bot.chat('Listo.');
  }

  // ---- Mina TODO el volumen entre dos esquinas (estilo WorldEdit):
  // genera todas las posiciones del cubo y va picando capa por capa. ----
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
      // ir CERCA del centro del cubo para forzar la carga de chunks
      // (GoalNear, no GoalBlock: si el cubo es sólido, el bot no puede entrar)
      const centro = new Vec3((minX + maxX) >> 1, (minY + maxY) >> 1, (minZ + maxZ) >> 1);
      await bot.pathfinder.goto(new goals.GoalNear(centro.x, centro.y, centro.z, 5));
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

      // filtrar solo bloques reales
      const bloques = [];
      for (const pos of posiciones) {
        const b = bot.blockAt(pos);
        if (b && !NO_MINABLES.has(b.name)) {
          bloques.push(b);
        }
      }

      if (bloques.length === 0) {
        bot.chat('No hay bloques minables en esa área');
        minando = false; reanudarAntiAfk(); return;
      }

      // los bloques bajo los pies del bot van al final (evita caerse mientras mina)
      const bajoPies = bloques.filter(b => {
        const p = bot.entity.position;
        return Math.floor(p.x) === b.position.x && Math.floor(p.z) === b.position.z && Math.floor(p.y) - 1 === b.position.y;
      });
      const resto = bloques.filter(b => !bajoPies.includes(b));
      const orden = [...resto, ...bajoPies];

      bot.chat(`Encontré ${orden.length} bloques minables. Picando...`);
      // por cada bloque: equipar pico, acercarse (GoalLookAtBlock) y dig con reintentos.
      // Si uno falla, sigue con el siguiente.
      let minados = 0;
      for (let i = 0; i < orden.length && minando && conexionViva(); i++) {
        const block = orden[i];
        try {
          await equiparMejorPico(block);
          const dist = bot.entity.position.distanceTo(block.position);
          if (dist > CONFIG.alcanceDig) {
            try {
              await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world, { reach: CONFIG.alcanceDig }));
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
        // recoger drops acumulados y gestionar inventario cada 10 bloques
        if (minados > 0 && minados % 10 === 0) {
          try { await recogerDropsCercanos(8); } catch (e) {}
          gestionarInventario();
          bot.chat(`Progreso: ${minados}/${orden.length} bloques minados`);
        }
      }
      // recoger drops restantes al terminar
      try { await recogerDropsCercanos(16); } catch (e) {}
      gestionarInventario();

      if (minando) bot.chat(`Área minada: ${minados}/${orden.length} bloques. Listo!`);
      else bot.chat(`Detenido con ${minados}/${orden.length} bloques minados`);
    } catch (e) {
      bot.chat(`Minado interrumpido: ${(e.message || e).slice(0, 60)}`);
    }
    minando = false;
    reanudarAntiAfk();
  }

  function pararMinado() {
    if (siguiendoA) {
      siguiendoA = null;
      if (seguirTimer) { clearInterval(seguirTimer); seguirTimer = null; }
      try { bot.pathfinder.stop(); } catch (e) {}
      reanudarAntiAfk();
      bot.chat('Dejé de seguirte.');
      return;
    }
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
  if (seguirTimer) { clearInterval(seguirTimer); seguirTimer = null; }
  minando = false;
  siguiendoA = null;
  seleccion = { pos1: null, pos2: null };

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