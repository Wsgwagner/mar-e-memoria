/* =====================================================
   Mar & Memória — servidor do modo online
   Express serve o jogo (pasta public) e o Socket.IO
   cuida das salas da Batalha Naval e do Jogo da Memória.

   Recursos: nomes provisórios (só em memória), revanche,
   reconexão por token (até 45 s), tempo limite por vez.
===================================================== */
'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const servidor = http.createServer(app);
const io = new Server(servidor);

app.use(express.static(path.join(__dirname, 'public')));

const PORTA = process.env.PORT || 3000;
/* Tempos configuráveis por variável de ambiente (facilita os testes) */
const TEMPO_VEZ_MS = parseInt(process.env.TEMPO_VEZ_MS, 10) || 60000; // 1 min por jogada
const AVISO_ANTES_MS = 15000;                                          // aviso 15 s antes
const QUEDA_MS = parseInt(process.env.QUEDA_MS, 10) || 45000;          // espera reconexão

/* ---------- Salas ---------- */
const salas = {};
const LETRAS_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sem I e O para não confundir

function novoCodigo() {
  let codigo;
  do {
    codigo = '';
    for (let i = 0; i < 4; i++) {
      codigo += LETRAS_CODIGO[Math.floor(Math.random() * LETRAS_CODIGO.length)];
    }
  } while (salas[codigo]);
  return codigo;
}

function novoToken() {
  return crypto.randomBytes(12).toString('hex');
}

/* Nome provisório do jogador: vive só na memória enquanto a sala existe.
   Nada é gravado em banco de dados ou arquivo. */
function limparNome(bruto, padrao) {
  const nome = String(bruto || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return nome || padrao;
}

function papelDe(sala, socket) {
  return sala.jogadores.indexOf(socket);
}

/* Envia um evento a um jogador; se ele estiver caído, guarda na fila
   e entrega tudo quando ele reconectar. */
function mandar(sala, papel, evento, dados) {
  const s = sala.jogadores[papel];
  if (s && s.connected) s.emit(evento, dados);
  else sala.pendentes[papel].push([evento, dados]);
}

function ambos(sala, evento, dados) {
  mandar(sala, 0, evento, dados);
  mandar(sala, 1, evento, dados);
}

function limparTimersVez(sala) {
  if (sala.timerVez) { clearTimeout(sala.timerVez); sala.timerVez = null; }
  if (sala.timerAviso) { clearTimeout(sala.timerAviso); sala.timerAviso = null; }
}

function destruirSala(sala) {
  limparTimersVez(sala);
  sala.timersQueda.forEach((t) => { if (t) clearTimeout(t); });
  sala.jogadores.forEach((s) => { if (s && s.data) s.data.codigo = null; });
  delete salas[sala.codigo];
}

/* ---------- Tempo limite por vez ---------- */
function vezAtual(sala) {
  if (sala.jogo === 'bn') return sala.bn && !sala.bn.fim ? sala.bn.vez : null;
  return sala.mem && !sala.mem.fim ? sala.mem.vez : null;
}

function armarVez(sala) {
  limparTimersVez(sala);
  const vez = vezAtual(sala);
  if (vez === null) return;
  if (TEMPO_VEZ_MS > AVISO_ANTES_MS) {
    sala.timerAviso = setTimeout(() => {
      mandar(sala, vez, 'vez:aviso', { segundos: Math.round(AVISO_ANTES_MS / 1000) });
    }, TEMPO_VEZ_MS - AVISO_ANTES_MS);
  }
  sala.timerVez = setTimeout(() => expirarVez(sala), TEMPO_VEZ_MS);
}

function expirarVez(sala) {
  if (sala.jogo === 'bn') {
    if (!sala.bn || sala.bn.fim || sala.bn.vez === null) return;
    sala.bn.vez = 1 - sala.bn.vez;
    ambos(sala, 'vez:passou', { jogo: 'bn', vez: sala.bn.vez });
  } else {
    const mem = sala.mem;
    if (!mem || mem.fim) return;
    const desvirar = mem.viradas.slice();
    desvirar.forEach((i) => { mem.cartas[i].estado = 'oculta'; });
    mem.viradas = [];
    mem.vez = 1 - mem.vez;
    ambos(sala, 'vez:passou', { jogo: 'mem', vez: mem.vez, desvirar });
  }
  armarVez(sala);
}

/* ---------- Batalha Naval (lado do servidor) ---------- */
const N = 10;
const TOTAL_NAVIOS = 5;

function novaBatalha() {
  return { frotas: [null, null], vez: null, fim: false };
}

function montarFrota(dados) {
  if (!dados || !Array.isArray(dados.navios) || dados.navios.length !== TOTAL_NAVIOS) return null;
  const grade = [];
  for (let r = 0; r < N; r++) { grade[r] = []; for (let c = 0; c < N; c++) grade[r][c] = -1; }
  const tiros = [];
  for (let r = 0; r < N; r++) { tiros[r] = []; for (let c = 0; c < N; c++) tiros[r][c] = null; }

  const navios = [];
  for (let i = 0; i < dados.navios.length; i++) {
    const n = dados.navios[i];
    if (!n || !Array.isArray(n.celulas) || n.celulas.length !== n.tam) return null;
    for (const p of n.celulas) {
      const r = p[0], c = p[1];
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= N || c < 0 || c >= N) return null;
      if (grade[r][c] !== -1) return null;
      grade[r][c] = i;
    }
    navios.push({ nome: String(n.nome), tam: n.tam, celulas: n.celulas, acertos: 0 });
  }
  return { grade, tiros, navios };
}

function atirarNaFrota(frota, r, c) {
  frota.tiros[r][c] = 'marcado';
  const idx = frota.grade[r][c];
  if (idx === -1) return { tipo: 'agua' };
  const nav = frota.navios[idx];
  nav.acertos++;
  if (nav.acertos === nav.tam) return { tipo: 'afundou', navio: nav.nome, celulas: nav.celulas };
  return { tipo: 'acerto', navio: nav.nome };
}

function frotaDestruida(frota) {
  return frota.navios.every((n) => n.acertos === n.tam);
}

/* ---------- Jogo da Memória (lado do servidor) ---------- */
const MEM_L = 4, MEM_C = 8;
const CARTAS_BASE = [
  { nome: 'Cachorro', emoji: '🐶' }, { nome: 'Gato', emoji: '🐱' },
  { nome: 'Peixe', emoji: '🐟' }, { nome: 'Passarinho', emoji: '🐦' },
  { nome: 'Cavalo', emoji: '🐴' }, { nome: 'Vaca', emoji: '🐮' },
  { nome: 'Sapo', emoji: '🐸' }, { nome: 'Coruja', emoji: '🦉' },
  { nome: 'Leão', emoji: '🦁' }, { nome: 'Tigre', emoji: '🐯' },
  { nome: 'Urso', emoji: '🐻' }, { nome: 'Panda', emoji: '🐼' },
  { nome: 'Coelho', emoji: '🐰' }, { nome: 'Raposa', emoji: '🦊' },
  { nome: 'Macaco', emoji: '🐵' }, { nome: 'Pinguim', emoji: '🐧' }
];

function novaMemoria() {
  const baralho = [];
  CARTAS_BASE.forEach((cta) => {
    baralho.push({ nome: cta.nome, emoji: cta.emoji, estado: 'oculta' });
    baralho.push({ nome: cta.nome, emoji: cta.emoji, estado: 'oculta' });
  });
  for (let i = baralho.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = baralho[i]; baralho[i] = baralho[j]; baralho[j] = t;
  }
  return {
    cartas: baralho,
    vez: Math.floor(Math.random() * 2),
    viradas: [],
    placar: [0, 0],
    paresEncontrados: 0,
    fim: false
  };
}

/* ---------- Início / reinício de partida ---------- */
function iniciarPartida(sala) {
  limparTimersVez(sala);
  if (sala.jogo === 'bn') {
    sala.bn = novaBatalha();
    /* o timer de vez só arma depois que as duas frotas chegam */
  } else {
    sala.mem = novaMemoria();
    ambos(sala, 'mem:comecar', { vez: sala.mem.vez });
    armarVez(sala);
  }
}

/* ---------- Conexões ---------- */
io.on('connection', (socket) => {
  socket.data.codigo = null;

  socket.on('sala:criar', (dados, responder) => {
    if (typeof responder !== 'function') return;
    const jogo = dados && dados.jogo === 'mem' ? 'mem' : 'bn';
    const codigo = novoCodigo();
    const nome = limparNome(dados && dados.nome, 'Jogador 1');
    salas[codigo] = {
      codigo, jogo,
      jogadores: [socket, null],
      nomes: [nome, null],
      tokens: [novoToken(), novoToken()],
      conectados: [true, false],
      pendentes: [[], []],
      timersQueda: [null, null],
      timerVez: null, timerAviso: null,
      revanche: [false, false],
      bn: null, mem: null
    };
    socket.data.codigo = codigo;
    responder({ ok: true, codigo });
  });

  socket.on('sala:entrar', (dados, responder) => {
    if (typeof responder !== 'function') return;
    const codigo = dados && typeof dados.codigo === 'string'
      ? dados.codigo.trim().toUpperCase() : '';
    const sala = salas[codigo];
    if (!sala) { responder({ ok: false, msg: 'Sala não encontrada. Confira o código.' }); return; }
    if (sala.jogadores[1]) { responder({ ok: false, msg: 'Esta sala já está cheia.' }); return; }
    sala.jogadores[1] = socket;
    sala.conectados[1] = true;
    socket.data.codigo = codigo;
    let nome = limparNome(dados && dados.nome, 'Jogador 2');
    if (nome.toLowerCase() === sala.nomes[0].toLowerCase()) nome = nome.slice(0, 18) + ' 2';
    sala.nomes[1] = nome;
    responder({ ok: true });

    sala.jogadores.forEach((s, papel) => {
      s.emit('sala:pronta', {
        papel, jogo: sala.jogo, codigo,
        nomes: sala.nomes, token: sala.tokens[papel]
      });
    });
    iniciarPartida(sala);
  });

  /* ----- Reconexão: o jogador caiu e voltou com o token ----- */
  socket.on('sala:retomar', (dados, responder) => {
    if (typeof responder !== 'function') return;
    const codigo = dados && typeof dados.codigo === 'string'
      ? dados.codigo.trim().toUpperCase() : '';
    const sala = salas[codigo];
    const token = dados && dados.token;
    const papel = sala ? sala.tokens.indexOf(token) : -1;
    if (!sala || papel === -1 || sala.conectados[papel]) {
      responder({ ok: false });
      return;
    }
    if (sala.timersQueda[papel]) { clearTimeout(sala.timersQueda[papel]); sala.timersQueda[papel] = null; }
    sala.jogadores[papel] = socket;
    sala.conectados[papel] = true;
    socket.data.codigo = codigo;
    responder({ ok: true });
    /* entrega tudo o que aconteceu enquanto o jogador estava fora */
    const fila = sala.pendentes[papel];
    sala.pendentes[papel] = [];
    fila.forEach(([ev, d]) => socket.emit(ev, d));
    mandar(sala, 1 - papel, 'oponente:voltou', {});
  });

  /* ----- Revanche ----- */
  socket.on('sala:revanche', () => {
    const sala = salas[socket.data.codigo];
    if (!sala || !sala.jogadores[1]) return;
    const papel = papelDe(sala, socket);
    if (papel === -1) return;
    const acabou = (sala.jogo === 'bn' && sala.bn && sala.bn.fim) ||
                   (sala.jogo === 'mem' && sala.mem && sala.mem.fim);
    if (!acabou) return;
    sala.revanche[papel] = true;
    if (sala.revanche[0] && sala.revanche[1]) {
      sala.revanche = [false, false];
      ambos(sala, 'sala:reiniciar', { jogo: sala.jogo });
      iniciarPartida(sala);
    } else {
      mandar(sala, 1 - papel, 'sala:revanche:pedida', { quem: papel });
    }
  });

  /* ----- Batalha Naval ----- */
  socket.on('bn:frota', (dados) => {
    const sala = salas[socket.data.codigo];
    if (!sala || sala.jogo !== 'bn' || !sala.bn) return;
    const papel = papelDe(sala, socket);
    if (papel === -1 || sala.bn.frotas[papel]) return;
    const frota = montarFrota(dados);
    if (!frota) { socket.emit('sala:erro', { msg: 'Frota inválida. Posicione novamente.' }); return; }
    sala.bn.frotas[papel] = frota;

    if (sala.bn.frotas[0] && sala.bn.frotas[1]) {
      sala.bn.vez = Math.floor(Math.random() * 2);
      ambos(sala, 'bn:comecar', { vez: sala.bn.vez });
      armarVez(sala);
    }
  });

  socket.on('bn:tiro', (dados) => {
    const sala = salas[socket.data.codigo];
    if (!sala || sala.jogo !== 'bn' || !sala.bn || sala.bn.fim) return;
    const papel = papelDe(sala, socket);
    if (papel === -1 || sala.bn.vez !== papel) return;
    const r = dados && dados.r, c = dados && dados.c;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= N || c < 0 || c >= N) return;
    const frotaAlvo = sala.bn.frotas[1 - papel];
    if (!frotaAlvo || frotaAlvo.tiros[r][c]) return;

    const res = atirarNaFrota(frotaAlvo, r, c);
    const fim = frotaDestruida(frotaAlvo);
    sala.bn.vez = 1 - papel;
    if (fim) sala.bn.fim = true;

    ambos(sala, 'bn:resultado', {
      atacante: papel, r, c, tipo: res.tipo,
      navio: res.navio || null,
      celulas: res.celulas || null,
      vez: sala.bn.vez,
      fim: fim || false,
      vencedor: fim ? papel : null
    });
    if (fim) limparTimersVez(sala);
    else armarVez(sala);
  });

  /* ----- Jogo da Memória ----- */
  socket.on('mem:virar', (dados) => {
    const sala = salas[socket.data.codigo];
    if (!sala || sala.jogo !== 'mem' || !sala.mem || sala.mem.fim) return;
    const mem = sala.mem;
    const papel = papelDe(sala, socket);
    if (papel === -1 || mem.vez !== papel) return;
    const idx = dados && dados.idx;
    if (!Number.isInteger(idx) || idx < 0 || idx >= MEM_L * MEM_C) return;
    const carta = mem.cartas[idx];
    if (carta.estado !== 'oculta' || mem.viradas.length >= 2) return;

    carta.estado = 'virada';
    mem.viradas.push(idx);
    ambos(sala, 'mem:carta', { idx, nome: carta.nome, emoji: carta.emoji, quem: papel });

    if (mem.viradas.length < 2) return;

    const [i1, i2] = mem.viradas;
    const c1 = mem.cartas[i1], c2 = mem.cartas[i2];
    const par = c1.nome === c2.nome;

    if (par) {
      c1.estado = 'encontrada'; c2.estado = 'encontrada';
      mem.placar[papel]++;
      mem.paresEncontrados++;
      /* quem acha o par joga de novo */
    } else {
      c1.estado = 'oculta'; c2.estado = 'oculta';
      mem.vez = 1 - papel;
    }
    mem.viradas = [];

    const fim = mem.paresEncontrados === CARTAS_BASE.length;
    let vencedor = null;
    if (fim) {
      mem.fim = true;
      if (mem.placar[0] > mem.placar[1]) vencedor = 0;
      else if (mem.placar[1] > mem.placar[0]) vencedor = 1;
      else vencedor = 'empate';
    }

    ambos(sala, 'mem:resultado', {
      indices: [i1, i2], par, quem: papel,
      placar: mem.placar.slice(), vez: mem.vez,
      fim, vencedor
    });
    if (fim) limparTimersVez(sala);
    else armarVez(sala);
  });

  /* ----- Queda de conexão ----- */
  socket.on('disconnect', () => {
    const sala = salas[socket.data.codigo];
    if (!sala) return;
    const papel = papelDe(sala, socket);
    if (papel === -1) return;

    /* sala de espera (segundo jogador nunca entrou): fecha direto */
    if (!sala.jogadores[1]) { destruirSala(sala); return; }

    sala.conectados[papel] = false;
    sala.jogadores[papel] = null;

    /* se os dois caíram, não há o que esperar */
    if (!sala.conectados[0] && !sala.conectados[1]) { destruirSala(sala); return; }

    mandar(sala, 1 - papel, 'oponente:caiu', { segundos: Math.round(QUEDA_MS / 1000) });
    sala.timersQueda[papel] = setTimeout(() => {
      mandar(sala, 1 - papel, 'oponente:saiu', {});
      destruirSala(sala);
    }, QUEDA_MS);
  });
});

servidor.listen(PORTA, () => {
  console.log('Mar & Memória rodando na porta ' + PORTA);
});
