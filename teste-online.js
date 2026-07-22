/* Teste do modo online: simula 2 jogadores na Batalha Naval e no Jogo da Memória */
'use strict';
const { io } = require('socket.io-client');
const URL = 'http://localhost:' + (process.env.PORT || 3000);

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

function frotaTeste() {
  // Frota fixa em linhas: linha 0 (5), linha 2 (4), linha 4 (3), linha 6 (3), linha 8 (2)
  const def = [
    { nome: 'Porta-aviões', tam: 5, linha: 0 },
    { nome: 'Encouraçado', tam: 4, linha: 2 },
    { nome: 'Cruzador', tam: 3, linha: 4 },
    { nome: 'Submarino', tam: 3, linha: 6 },
    { nome: 'Destroyer', tam: 2, linha: 8 }
  ];
  return {
    navios: def.map((d) => ({
      nome: d.nome, tam: d.tam,
      celulas: Array.from({ length: d.tam }, (_, i) => [d.linha, i])
    }))
  };
}

async function testeBatalha() {
  const a = io(URL), b = io(URL);
  let vez = null, tiros = 0, fimInfo = null;
  const papeis = {};

  a.on('sala:pronta', (d) => { papeis.a = d.papel; console.log('[BN] nomes na sala:', d.nomes.join(' vs ')); });
  b.on('sala:pronta', (d) => { papeis.b = d.papel; });

  const codigo = await new Promise((res) => {
    a.emit('sala:criar', { jogo: 'bn', nome: 'Wagner' }, (r) => res(r.codigo));
  });
  console.log('[BN] sala criada:', codigo);

  await new Promise((res) => b.emit('sala:entrar', { codigo, nome: 'Maria' }, (r) => {
    if (!r.ok) throw new Error('entrar falhou: ' + r.msg);
    res();
  }));

  const comecou = new Promise((res) => a.on('bn:comecar', (d) => res(d.vez)));
  a.emit('bn:frota', frotaTeste());
  b.emit('bn:frota', frotaTeste());
  vez = await comecou;
  console.log('[BN] começou, vez do papel', vez);

  // Estratégia: quem está na vez atira varrendo o tabuleiro inteiro
  const proximoTiro = { 0: 0, 1: 0 }; // contador linear por papel
  function soquetePorPapel(p) { return papeis.a === p ? a : b; }

  const fim = new Promise((res) => {
    function aoResultado(d) {
      tiros++;
      if (d.fim) { fimInfo = d; res(); return; }
      vez = d.vez;
      atirar();
    }
    a.on('bn:resultado', (d) => { /* só um dos lados processa o fluxo */ });
    b.on('bn:resultado', aoResultado);
    // usar o lado A para logar acertos importantes
    a.on('bn:resultado', (d) => {
      if (d.tipo === 'afundou') console.log('[BN] papel', d.atacante, 'afundou o', d.navio);
    });
  });

  function atirar() {
    const s = soquetePorPapel(vez);
    const n = proximoTiro[vez]++;
    const r = Math.floor(n / 10), c = n % 10;
    s.emit('bn:tiro', { r, c });
  }
  atirar();
  await fim;
  console.log('[BN] fim de jogo. vencedor: papel', fimInfo.vencedor, '| tiros trocados:', tiros);

  // Teste extra: atirar fora da vez deve ser ignorado (sem resposta)
  let respostaIndevida = false;
  a.on('bn:resultado', () => { respostaIndevida = true; });
  soquetePorPapel(1 - fimInfo.vencedor).emit('bn:tiro', { r: 9, c: 9 });
  await esperar(300);
  console.log('[BN] tiro após o fim ignorado:', !respostaIndevida ? 'OK' : 'FALHOU');

  a.disconnect(); b.disconnect();
}

async function testeMemoria() {
  const a = io(URL), b = io(URL);
  const papeis = {};
  a.on('sala:pronta', (d) => { papeis.a = d.papel; console.log('[MEM] nomes na sala (iguais de propósito):', d.nomes.join(' vs ')); });
  b.on('sala:pronta', (d) => { papeis.b = d.papel; });

  const codigo = await new Promise((res) => {
    a.emit('sala:criar', { jogo: 'mem', nome: 'Wagner' }, (r) => res(r.codigo));
  });
  console.log('[MEM] sala criada:', codigo);

  let vez = null;
  const comecou = new Promise((res) => a.on('mem:comecar', (d) => res(d.vez)));
  await new Promise((res) => b.emit('sala:entrar', { codigo, nome: 'Wagner' }, () => res()));
  vez = await comecou;
  console.log('[MEM] começou, vez do papel', vez);

  // Descobrir cartas conforme aparecem para formar pares de propósito
  const vistas = {};      // nome -> [indices]
  const encontradas = new Set();
  let proxima = 0;
  function soquete(p) { return papeis.a === p ? a : b; }

  function escolherJogada() {
    // se conheço um par ainda não encontrado, viro ele
    for (const nome in vistas) {
      const idxs = vistas[nome].filter((i) => !encontradas.has(i));
      if (idxs.length >= 2) return [idxs[0], idxs[1]];
    }
    // senão viro as duas próximas desconhecidas
    const livres = [];
    while (livres.length < 2 && proxima < 32) {
      if (!encontradas.has(proxima)) livres.push(proxima);
      proxima++;
    }
    return livres;
  }

  a.on('mem:carta', (d) => {
    vistas[d.nome] = vistas[d.nome] || [];
    if (!vistas[d.nome].includes(d.idx)) vistas[d.nome].push(d.idx);
  });

  const fim = new Promise((res) => {
    a.on('mem:resultado', (d) => {
      if (d.par) d.indices.forEach((i) => encontradas.add(i));
      if (d.fim) { res(d); return; }
      vez = d.vez;
      jogar();
    });
  });

  function jogar() {
    const s = soquete(vez);
    const [i1, i2] = escolherJogada();
    s.emit('mem:virar', { idx: i1 });
    setTimeout(() => s.emit('mem:virar', { idx: i2 }), 30);
  }
  jogar();
  const resultado = await fim;
  console.log('[MEM] fim. placar:', resultado.placar.join(' x '),
    '| vencedor:', resultado.vencedor, '| pares no tabuleiro:', encontradas.size / 2);

  // ----- Revanche: um pede, o outro é avisado, os dois aceitam -----
  const avisoRevanche = new Promise((res) => b.once('sala:revanche:pedida', res));
  const reinicioA = new Promise((res) => a.once('sala:reiniciar', res));
  const novoComecar = new Promise((res) => a.once('mem:comecar', (d) => res(d)));
  a.emit('sala:revanche');
  await avisoRevanche;
  console.log('[REVANCHE] adversário avisado do pedido: OK');
  b.emit('sala:revanche');
  const rein = await reinicioA;
  const nc = await novoComecar;
  console.log('[REVANCHE] partida reiniciada (jogo:', rein.jogo + ', vez do papel', nc.vez + '): OK');

  a.disconnect(); b.disconnect();
}

async function testeReconexao() {
  const a = io(URL), b = io(URL);
  const tokens = {}, papeis = {};
  a.on('sala:pronta', (d) => { papeis.a = d.papel; tokens.a = d.token; });
  b.on('sala:pronta', (d) => { papeis.b = d.papel; tokens.b = d.token; });

  const codigo = await new Promise((res) => {
    a.emit('sala:criar', { jogo: 'bn', nome: 'Wagner' }, (r) => res(r.codigo));
  });
  await new Promise((res) => b.emit('sala:entrar', { codigo, nome: 'Maria' }, () => res()));

  const comecou = new Promise((res) => a.on('bn:comecar', (d) => res(d.vez)));
  a.emit('bn:frota', frotaTeste());
  b.emit('bn:frota', frotaTeste());
  const vez = await comecou;

  // B cai no meio da partida
  const caiu = new Promise((res) => a.once('oponente:caiu', res));
  b.disconnect();
  await caiu;
  console.log('[RECONEXÃO] queda detectada e avisada ao adversário: OK');

  // Se for a vez de A, ele atira enquanto B está fora (o evento fica na fila)
  if (vez === papeis.a) {
    const resultadoA = new Promise((res) => a.once('bn:resultado', res));
    a.emit('bn:tiro', { r: 9, c: 9 });
    await resultadoA;
  }

  // B volta com o token
  const b2 = io(URL);
  const eventosB2 = [];
  b2.onAny((ev) => eventosB2.push(ev));
  const voltou = new Promise((res) => a.once('oponente:voltou', res));
  await new Promise((res) => b2.on('connect', res));
  const resp = await new Promise((res) => {
    b2.emit('sala:retomar', { codigo, token: tokens.b }, res);
  });
  if (!resp.ok) throw new Error('sala:retomar falhou');
  await voltou;
  await esperar(300);
  const recebeuFila = vez !== papeis.a || eventosB2.includes('bn:resultado');
  console.log('[RECONEXÃO] retomada com token e fila entregue:', recebeuFila ? 'OK' : 'FALHOU');

  // Token errado deve ser recusado
  const b3 = io(URL);
  await new Promise((res) => b3.on('connect', res));
  const respRuim = await new Promise((res) => {
    b3.emit('sala:retomar', { codigo, token: 'token-falso' }, res);
  });
  console.log('[RECONEXÃO] token inválido recusado:', !respRuim.ok ? 'OK' : 'FALHOU');

  a.disconnect(); b2.disconnect(); b3.disconnect();
}

async function testeTempoVez() {
  const a = io(URL), b = io(URL);
  const codigo = await new Promise((res) => {
    a.emit('sala:criar', { jogo: 'bn', nome: 'Wagner' }, (r) => res(r.codigo));
  });
  await new Promise((res) => b.emit('sala:entrar', { codigo, nome: 'Maria' }, () => res()));
  const comecou = new Promise((res) => a.on('bn:comecar', (d) => res(d.vez)));
  a.emit('bn:frota', frotaTeste());
  b.emit('bn:frota', frotaTeste());
  const vez = await comecou;

  // Ninguém atira: a vez deve passar sozinha pelo tempo limite
  const passou = await new Promise((res) => a.once('vez:passou', res));
  console.log('[TEMPO] vez passou sozinha de', vez, 'para', passou.vez, ':',
    passou.vez === 1 - vez ? 'OK' : 'FALHOU');
  a.disconnect(); b.disconnect();
}

async function testeSalaErrada() {
  const a = io(URL);
  const r = await new Promise((res) => a.emit('sala:entrar', { codigo: 'ZZZZ' }, res));
  console.log('[SALA] código inexistente rejeitado:', !r.ok ? 'OK (' + r.msg + ')' : 'FALHOU');
  a.disconnect();
}

(async () => {
  try {
    await testeSalaErrada();
    await testeBatalha();
    await testeMemoria();
    await testeReconexao();
    await testeTempoVez();
    console.log('\nTODOS OS TESTES CONCLUÍDOS');
    process.exit(0);
  } catch (e) {
    console.error('TESTE FALHOU:', e);
    process.exit(1);
  }
})();
