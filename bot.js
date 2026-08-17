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
const mc = require('minecraft-protocol'); // ping ligero antes de conectar (anti rate-limit Aternos)

const CONFIG = {
  host: 'sanfranblock.aternos.me',
  port: 38089,
  username: 'Chambeador',
  auth: 'offline',          // server cracked (sin premium/login)
  version: '1.21.1',        // Paper 26.2 = protocol 776 = 1.21.1 (ViaVersion traduce)
  checkTimeoutInterval: 300000, // 5 min (default 30s) — evita desconexión por lag Aternos
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
let atascoTimer = null;      // monitor de atascos del pathfinder
let ultimaPosMovimiento = null;
let intentosLiberacion = 0;
let destinoMinado = null;    // centro del cubo actual (para tp de emergencia)

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

// ---- Diagnóstico (para debug remoto sin logs) ----
const DIAG = {
  ultimoPing: null,      // {ok, error, hora}
  ultimoError: null,     // {msg, code, hora}
  intentos: 0,           // intentos de conexión totales
  pingsOk: 0,
  pingsFail: 0,
  ultimoIntento: null,
  estado: 'iniciando',
  ipPublica: null,       // IP pública del host (para debug de bloqueos)
};

// Reportar IP pública del host (útil para debug de bloqueos Aternos)
try {
  const req = http.get('http://api.ipify.org', (r) => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => { DIAG.ipPublica = d.trim(); });
  });
  req.setTimeout(5000, () => req.destroy());
  req.on('error', () => {});
} catch (e) {}

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
    diag: DIAG,
  }));
});
const HTTP_PORT = process.env.PORT || 3000;
server.listen(HTTP_PORT, () => {
  console.log(`[${hora()}] HTTP keep-alive en puerto ${HTTP_PORT}`);
});

function crearBot() {
  if (reconectando) return;
  console.log(`[${hora()}] Conectando como ${CONFIG.username} a ${CONFIG.host}:${CONFIG.port}...`);

  // Gate anti rate-limit (Aternos): Aternos duerme el server sin jugadores y lo
  // despierta con cualquier conexión. Pero N conexiones completas seguidas desde
  // la misma IP (p. ej. IPs de datacenter como Render, muy reportadas por abuso)
  // disparan un rate-limit/bloqueo temporal de Aternos. Estrategia: primero un
  // ping ligero; si el server no responde, esperar 5 min (el ping también lo
  // despierta). Solo se abre conexión completa cuando el server responde.
  const pingTimeout = setTimeout(() => {
    console.log(`[${hora()}] ⚠️ Ping timeout (5s). Server no responde. Reintento en 5 min`);
    esperandoServerOffline = true;
    DIAG.ultimoPing = { ok: false, error: 'timeout 5s', hora: hora() };
    DIAG.pingsFail++;
    setTimeout(() => { reconectando = false; crearBot(); }, 300000);
  }, 5000);

  mc.ping({ host: CONFIG.host, port: CONFIG.port, version: CONFIG.version }, (err) => {
    clearTimeout(pingTimeout);
    DIAG.ultimoIntento = hora();
    DIAG.intentos++;
    if (err) {
      esperandoServerOffline = true;
      DIAG.ultimoPing = { ok: false, error: err.code || err.message, hora: hora() };
      DIAG.pingsFail++;
      console.log(`[${hora()}] ⚠️ Server dormido (ping: ${err.code || err.message}). Reintento en 5 min (el ping lo despierta)`);
      setTimeout(() => { reconectando = false; crearBot(); }, 300000);
      return;
    }
    DIAG.ultimoPing = { ok: true, hora: hora() };
    DIAG.pingsOk++;
    DIAG.estado = 'ping ok — conectando';
    console.log(`[${hora()}] ✅ Ping OK — server responde, conectando...`);
    crearBotReal();
  });
}

function crearBotReal() {

  bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    auth: CONFIG.auth,
    version: CONFIG.version,
    checkTimeoutInterval: CONFIG.checkTimeoutInterval,
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
      movements.allowParkour = true; // saltar huecos de 1 sin quedarse pegado
      bot.pathfinder.setMovements(movements);
    } catch (e) {
      console.log(`[${hora()}] ⚠️ No se pudo configurar pathfinder: ${e.message}`);
    }
    arrancarAntiAfk();
    arrancarWatchdog();
    arrancarChat();
    arrancarMonitorAtascos();
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
      } else if (cmd === '!estado') {
        // Mostrar qué item tiene el bot en la mano y en el inventario
        if (!bot.entity) { bot.chat('Sin conexión'); return; }
        const main = bot.inventory.getItemInMainHand();
        bot.chat(`Main hand: ${main ? main.name : 'vacia'}`);
        // Contar herramientas (pico, pala, hacha) en el inventario
        const herramientas = bot.inventory.items().filter(i => /pickaxe|shovel|axe|hoe/.test(i.name.toLowerCase()));
        bot.chat(`Herramientas en inventario: ${herramientas.length} (${herramientas.map(i => i.name).join(', ') || 'ninguna'})`);
      } else if (cmd === '!tira' && args.length >= 2) {
        tirarItem(args.slice(1).join(' '));
      } else if (cmd === '!recoge') {
        recogerTodo();
      } else if (cmd === '!donde') {
        const p = bot.entity ? bot.entity.position : null;
        bot.chat(p ? `Estoy en ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} (mírame y usa !ven)` : 'No tengo posición');
      } else if (cmd === '!pos1' || cmd === '!pos2') {
        const n = cmd === '!pos1' ? 1 : 2;
        // si viene con coordenadas directas, no depende de la mirada del jugador
        if (args.length >= 4) {
          const [x, y, z] = args.slice(1, 4).map(Number);
          if ([x, y, z].every(v => Number.isFinite(v))) {
            seleccion[n === 1 ? 'pos1' : 'pos2'] = new Vec3(x, y, z);
            anunciarMarca(n, new Vec3(x, y, z), 'coordenadas directas');
          } else {
            bot.chat(`Uso: !pos${n} <x> <y> <z> — o apunta al bloque y escribe !pos${n}`);
          }
        } else {
          marcarPos(n, nombreLimpio);
        }
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
    if (!jugador) return { ok: false, retryable: true, razon: `No te detecto (${username})` };
    try {
      const pos = jugador.position;
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        return { ok: false, razon: 'Tu posición aún no está cargada' };
      }
      const ojo = pos.offset(0, 1.62, 0); // altura de los ojos
      // El server redondea la rotación del jugador (pitch cuantizado a π/128).
      // Al mirar un bloque a nivel de los pies, el rayo exacto pasa POR ENCIMA
      // y se va al horizonte. Barrido: rayo exacto primero, luego desviaciones
      // hacia abajo (caso típico), luego hacia arriba. Primer hit gana.
      const desviaciones = [0, -0.05, -0.1, -0.15, 0.05, 0.1, 0.15];
      for (const off of desviaciones) {
        const dir = new Vec3(
          -Math.sin(jugador.yaw) * Math.cos(jugador.pitch + off),
          -Math.sin(jugador.pitch + off),
          -Math.cos(jugador.yaw) * Math.cos(jugador.pitch + off)
        );
        const hit = bot.world.raycast(ojo, dir, 64, (block) => block && !NO_MINABLES.has(block.name));
        if (hit) return { ok: true, pos: hit.position };
      }
      return { ok: false, retryable: true, razon: 'No veo un bloque en tu línea de mira' };
    } catch (e) {
      console.log(`[${hora()}] ⚠️ Error raycast: ${e.message}`);
      return { ok: false, razon: 'Error calculando tu mirada' };
    }
  }

  async function marcarPos(n, username) {
    // El server NO reenvía la rotación del jugador si está quieto (solo al
    // moverse). Reintentar 5 veces × 2s para dar tiempo a que llegue.
    let res = null;
    for (let i = 0; i < 5; i++) {
      res = bloqueQueMira(username);
      if (res.ok) break;
      if (!res.retryable) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!res || !res.ok) {
      const p = bot.entity ? bot.entity.position : null;
      bot.chat(p
        ? `${res ? res.razon : 'No te detecto'}. Rota la cámara y DA UN PASO, luego reintenta (el server solo me envía tu mirada cuando te mueves). Estoy en ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
        : 'No te detecto');
      return;
    }
    seleccion[n === 1 ? 'pos1' : 'pos2'] = res.pos;
    anunciarMarca(n, res.pos);
  }

  function mostrarSeleccion() {
    const p1 = seleccion.pos1, p2 = seleccion.pos2;
    if (!p1 && !p2) { bot.chat('Selección vacía. Usa !pos1 y !pos2 mirando los bloques'); return; }
    bot.chat(`Pos1: ${p1 ? `${p1.x} ${p1.y} ${p1.z}` : '—'} | Pos2: ${p2 ? `${p2.x} ${p2.y} ${p2.z}` : '—'}`);
  }

  // Anunciar una marca + recordar qué falta (pos1 o pos2) para que el usuario
  // entienda que necesita DOS esquinas opuestas del volumen
  function anunciarMarca(n, pos, modo) {
    const otra = n === 1 ? 'pos2' : 'pos1';
    const falta = seleccion[otra] ? '' : ` Ahora marca la esquina OPUESTA con !${otra} (ej: !${otra} x y z)`;
    bot.chat(`Pos${n} marcada: ${pos.x} ${pos.y} ${pos.z}${modo ? ` (${modo})` : ''}.${falta}`);
  }

  function minarSeleccion() {
    const p1 = seleccion.pos1, p2 = seleccion.pos2;
    if (!p1 || !p2) {
      bot.chat('Necesitas marcar !pos1 y !pos2 primero');
      return;
    }
    // Aviso si el cubo quedó plano (mismo plano X, Z o Y) — el usuario marcó dos
    // puntos de la misma cara/pared en vez de esquinas opuestas
    const planosIguales = (p1.x === p2.x) ? 'X' : (p1.z === p2.z) ? 'Z' : (p1.y === p2.y) ? 'Y' : null;
    if (planosIguales) {
      const eje = planosIguales === 'X' ? 'misma coordenada X' : planosIguales === 'Z' ? 'misma coordenada Z' : 'la misma altura (Y)';
      bot.chat(`⚠ Las dos posiciones tienen ${eje} → el cubo será de 1 bloque de grosor. Marca esquinas OPUESTAS del volumen (abajo-izquierda y arriba-derecha en diagonal).`);
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
    const slots = bot.inventory.slots; // array en mineflayer 4.x (NO es función)
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

  // ---- Monitor de atascos: si el pathfinder intenta moverse pero el bot no
  // avanza (típico al saltar contra un borde o en un hueco), intenta liberarse
  // saltando Y avanzando a la vez; si persiste, se teletransporta (es OP). ----
  function arrancarMonitorAtascos() {
    if (atascoTimer) clearInterval(atascoTimer);
    atascoTimer = setInterval(() => {
      if (!conexionViva()) return;
      try {
        const p = bot.entity.position;
        const moviendose = bot.pathfinder.isMoving() || bot.pathfinder.isPathing();
        if (!moviendose) { ultimaPosMovimiento = null; intentosLiberacion = 0; return; }
        if (!ultimaPosMovimiento) { ultimaPosMovimiento = p.clone(); return; }
        const avanzado = p.distanceTo(ultimaPosMovimiento);
        ultimaPosMovimiento = p.clone();
        if (avanzado > 0.3) { intentosLiberacion = 0; return; } // avanzó bien

        // estancado mientras intenta moverse → liberarse saltando + avanzando
        intentosLiberacion++;
        if (intentosLiberacion <= 3) {
          bot.setControlState('jump', true);
          bot.setControlState('forward', true);
          setTimeout(() => {
            bot.setControlState('jump', false);
            bot.setControlState('forward', false);
          }, 1200);
          if (intentosLiberacion === 1) bot.chat('Estoy atascado, intento liberarme...');
        } else {
          // atascado persistente → teletransporte de emergencia a un lugar
          // seguro cerca del cubo (o al spawn si no hay cubo)
          intentosLiberacion = 0;
          try { bot.pathfinder.stop(); } catch (e) {}
          const lugar = destinoMinado
            ? buscarLugarParado(destinoMinado.x, destinoMinado.y, destinoMinado.z)
            : null;
          if (lugar) {
            bot.chat('No puedo avanzar, me teletransporto cerca del cubo...');
            bot.chat(`/tp ${bot.username} ${lugar.x} ${lugar.y} ${lugar.z}`);
          } else {
            bot.chat('No puedo avanzar, me teletransporto al spawn...');
            bot.chat(`/tp ${bot.username} ${bot.spawnPoint.x} ${bot.spawnPoint.y} ${bot.spawnPoint.z}`);
          }
        }
      } catch (e) { /* no fatal */ }
    }, 2000);
  }

  // ---- Vigilar vida/hambre/peligro mientras mina ----
  let comiendo = false;
  let ultimoPedidoComida = 0;
  const COMIDA_PREFERIDA = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'bread', 'apple', 'baked_potato', 'golden_apple'];

  // comer si hay hambre: busca comida en el inventario; si no hay, el bot es OP
  // así que se da comida a sí mismo con /give y la come.
  async function comerSiHambre() {
    if (comiendo || !bot.entity || bot.food >= 10) return;
    comiendo = true;
    try {
      let comida = bot.inventory.items().find(i => COMIDA_PREFERIDA.includes(i.name));
      if (!comida) {
        if (Date.now() - ultimoPedidoComida > 60000) {
          ultimoPedidoComida = Date.now();
          bot.chat(`/give ${bot.username} cooked_beef 64`);
          await new Promise(r => setTimeout(r, 2500));
          comida = bot.inventory.items().find(i => COMIDA_PREFERIDA.includes(i.name));
        } else {
          return; // ya pedimos hace poco, esperar a que llegue
        }
      }
      if (!comida) return;
      await bot.equip(comida, 'hand');
      // consumir con timeout: no colgar nunca
      await Promise.race([
        bot.consume(),
        new Promise(r => setTimeout(r, 8000)),
      ]);
      console.log(`[${hora()}] 🍖 Comí ${comida.name} (hambre: ${bot.food})`);
    } catch (e) {
      console.log(`[${hora()}] ⚠️ No pude comer: ${(e.message || e).slice(0, 50)}`);
    } finally {
      comiendo = false;
    }
  }

  function vigilarVida() {
    if (minarVigiaTimer) clearInterval(minarVigiaTimer);
    minarVigiaTimer = setInterval(() => {
      if (!minando) { clearInterval(minarVigiaTimer); minarVigiaTimer = null; return; }
      // vida < 3 corazones → PELIGRO real, parar
      if (bot.health < 6) {
        try { bot.pathfinder.stop(); } catch (e) {}
        bot.chat('Me estoy muriendo, paro de minar');
        minando = false;
        clearInterval(minarVigiaTimer); minarVigiaTimer = null;
        reanudarAntiAfk();
        return;
      }
      // hambre baja → comer en vez de abortar (el bot nunca comía: llevaba
      // días con food=0 y abortaba TODO el minado a los 3 segundos)
      if (bot.food < 6) comerSiHambre();
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
      // 1) Intentar que el plugin mineflayer-tool lo equipé (mejor para diamante/hierro nativos)
      await bot.tool.equipForBlock(block);
      return;
    } catch (e) { /* el plugin no pudo equiparlo (puede ser NBT/encantado) */ }

    // 2) Fallback: buscar cualquier item en el inventario que sea una herramienta
    // revisando el nombre (funciona con picos encantados que tienen NBT en su nombre)
    const bajo = block.name.toLowerCase();
    let herramienta = null;
    for (const item of bot.inventory.items()) {
      const itemBajo = item.name.toLowerCase();
      // Coincide: diamond_pickaxe, iron_pickaxe, wooden_pickaxe, stone_pickaxe
      // También: diamond_pickaxe{...}, netherite_pickaxe, etc. (el contains 'pickaxe')
      if (/pickaxe|shovel|axe|hoe/.test(itemBajo)) {
        herramienta = item;
        break;
      }
    }
    if (herramienta) {
      try { await bot.equip(herramienta, 'hand'); } catch (e) { /* ignored */ }
      return;
    }

    // 3) Sin herramienta encontrada: mina a mano (será muy lento para bloques duros)
    console.log(`[${hora()}] ⚠️ No encontré herramienta en el inventario, minando a mano`);
  }

  // ---- Mina UN bloque en coordenadas ----
  async function minarBloque(x, y, z) {
    if (!conexionViva()) return;
    if (minando) { bot.chat('Ya estoy minando, usa !stop primero'); return; }
    minando = true;
    pausarAntiAfk();
    vigilarVida();
    comerSiHambre(); // comer antes de minar (el bot nunca comía)
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
    comerSiHambre(); // comer antes de minar (el bot nunca comía)
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
    comerSiHambre(); // comer antes de minar (el bot nunca comía)
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
    // El tipo puede llevar NBT data opcional (ej. "diamante{sharpness:5}")
    const coincide = tipo ? tipo.match(/^([^\{\]+]+)?(.*)?$/) : null;
    const nombreBase = (coincide && coincide[1]) ? coincide[1].trim() : (tipo || 'hierro').toLowerCase();
    const nbtData = (coincide && coincide[2]) ? coincide[2].trim() : '';
    const picoBase = PICOS[nombreBase] || nombreBase;
    const pico = nbtData ? `${picoBase}${nbtData}` : picoBase;
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

  // ---- Tirar items del inventario (!tira <nombre>) ----
  // Útil para que el bot use SOLO el pico que el jugador le dio: tira los
  // picos auto-generados con /give y mineflayer-tool usará el que quede.
  async function tirarItem(nombre) {
    if (!conexionViva()) return;
    const termino = nombre.toLowerCase().replace('pico', 'pickaxe');
    const items = bot.inventory.items().filter(i => i.name.includes(termino));
    if (items.length === 0) {
      bot.chat(`No tengo "${nombre}" en el inventario. Tengo: ${bot.inventory.items().map(i => i.name).join(', ') || 'nada'}`);
      return;
    }
    let tirados = 0;
    for (const item of items) {
      try {
        await bot.tossStack(item);
        tirados += item.count;
      } catch (e) { /* seguir con el siguiente */ }
    }
    bot.chat(`Tiré ${tirados} ${items[0].name}${items.length > 1 ? ' (y otros que coincidían)' : ''}`);
  }

  // ---- Recoger todos los drops cercanos (!recoge) ----
  async function recogerTodo() {
    if (!conexionViva()) return;
    bot.chat('Recogiendo items cercanos...');
    await recogerDropsCercanos(32);
    bot.chat('Listo.');
  }

  // ---- Buscar un lugar seguro y parado cerca de una posición (para /tp):
  // bloque sólido debajo, aire en pies y cabeza. Escanea capas dy=-2..+2 y
  // radios 1..8 alrededor del centro del cubo. ----
  function buscarLugarParado(cx, cy, cz) {
    for (let dy = -2; dy <= 2; dy++) {
      const y = cy + dy;
      for (let r = 1; r <= 8; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // solo borde del radio
            const x = cx + dx, z = cz + dz;
            const abajo = bot.blockAt(new Vec3(x, y - 1, z));
            const pies = bot.blockAt(new Vec3(x, y, z));
            const cabeza = bot.blockAt(new Vec3(x, y + 1, z));
            if (abajo && abajo.boundingBox === 'block' &&
                pies && pies.boundingBox !== 'block' &&
                cabeza && cabeza.boundingBox !== 'block') {
              return new Vec3(x, y, z);
            }
          }
        }
      }
    }
    return null;
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
    comerSiHambre(); // comer antes de minar (el bot nunca comía)
    bot.chat(`Minando cubo ${minX},${minY},${minZ} → ${maxX},${maxY},${maxZ} (${volumen} bloques de volumen)`);

    try {
      // ir CERCA del centro del cubo para forzar la carga de chunks
      // (GoalNear, no GoalBlock: si el cubo es sólido, el bot no puede entrar)
      const centro = new Vec3((minX + maxX) >> 1, (minY + maxY) >> 1, (minZ + maxZ) >> 1);
      destinoMinado = centro; // para el tp de emergencia del monitor de atascos
      // si el cubo está lejos o muy por encima (ruta imposible: canDig=false,
      // sin torres), el bot es OP → se teletransporta a un lugar seguro cercano
      const distBot = bot.entity.position.distanceTo(centro);
      if (distBot > 15 || Math.abs(bot.entity.position.y - centro.y) > 4) {
        const lugar = buscarLugarParado(centro.x, centro.y, centro.z);
        if (lugar) {
          bot.chat(`El cubo está a ${Math.round(distBot)} bloques, me teletransporto cerca...`);
          bot.chat(`/tp ${bot.username} ${lugar.x} ${lugar.y} ${lugar.z}`);
          await new Promise(r => setTimeout(r, 3000)); // esperar a que carguen chunks
        } else {
          bot.chat('No encuentro un lugar seguro cerca del cubo, intento caminar...');
        }
      }
      try {
        await bot.pathfinder.goto(new goals.GoalNear(centro.x, centro.y, centro.z, 5));
      } catch (e) {
        // ruta imposible no es fatal: cada bloque se intenta por separado
        console.log(`[${hora()}] ⚠️ GoalNear falló (no fatal): ${(e.message || e).slice(0, 50)}`);
      }
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
        if (minados > 0 && minados % 500 === 0) {
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
    destinoMinado = null;
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
    DIAG.ultimoError = { msg: err.message, code: err.code || null, hora: hora() };
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

  const delay = esperandoServerOffline ? 30000 : 5000;
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