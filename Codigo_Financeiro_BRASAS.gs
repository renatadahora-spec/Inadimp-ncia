/**
 * FINANCEIRO BRASAS - Cards de títulos vencidos por escola
 * Planilha: "Títulos vencidos - 2026"  (abas: MM/AAAA e "Pagos")
 *
 * Fluxo: lê as abas de mês e Pagos -> dá baixa nos pagos -> atualiza a planilha de cada escola no Drive -> resumos -> cards por e-mail.
 * Modos (aba Config, célula B1):
 *   RASCUNHO = cria rascunhos no seu Gmail (destino: DESTINO_TESTE)   <- padrão
 *   TESTE    = envia para DESTINO_TESTE (renatadahora@brasas.com)
 *   PRODUCAO = envia para o e-mail do gerente de cada escola (aba Config, tabela de escolas), com cópia para você
 */

/* ===================== PARTE PURA (testável fora do Google) ===================== */

var AGING_FAIXAS = [
  { rotulo: '1 a 7 dias',   min: 1,  max: 7 },
  { rotulo: '8 a 15 dias',  min: 8,  max: 15 },
  { rotulo: '16 a 30 dias', min: 16, max: 30 },
  { rotulo: '31 a 60 dias', min: 31, max: 60 },
  { rotulo: 'Mais de 60 dias', min: 61, max: 99999 }
];

function fmtBRL_(n) {
  var neg = n < 0; n = Math.abs(n);
  var p = n.toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + 'R$ ' + p[0] + ',' + p[1];
}
function fmtData_(d) {
  function z(x) { return (x < 10 ? '0' : '') + x; }
  return z(d.getDate()) + '/' + z(d.getMonth() + 1) + '/' + d.getFullYear();
}
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function paraNumero_(v) {
  if (typeof v === 'number') return v;
  var s = String(v || '').replace(/[R$\s]/g, '');
  if (!s) return 0;
  if (s.indexOf(',') > -1) s = s.replace(/\./g, '').replace(',', '.');
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function paraData_(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  var m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}
function diasEntre_(vcto, hoje) {
  var h = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  return Math.round((h - vcto) / 86400000);
}

/**
 * valores: matriz da aba (linha 0 = cabeçalho).
 * pagos: objeto {numeroTitulo: true} vindo da aba Pagos.
 * excluidas: array de unidades a ignorar (ex.: ['Professores']).
 * Retorna { 'Unidade': [ {vcto, titulo, aluno, valor, atraso, descricao} ] }
 */
function agruparAbertosPorUnidade_(valores, pagos, excluidas, hoje) {
  var h = valores[0].map(function (x) { return String(x).trim(); });
  var ix = function (nome) { return h.indexOf(nome); };
  var cV = ix('Vcto'), cT = ix('Título'), cS = ix('Sacado'), cP = ix('Vl. prev.'),
      cR = ix('Vl. receb.'), cSit = ix('Situação'), cU = ix('Unidade'), cD = ix('Descrição'), cB = ix('Dt. baixa');
  if ([cV, cT, cS, cP, cR, cSit, cU].some(function (c) { return c < 0; })) {
    throw new Error('Cabeçalho da aba fora do padrão. Colunas esperadas: Vcto, Título, Sacado, Vl. prev., Vl. receb., Situação, Unidade.');
  }
  var out = {};
  for (var i = 1; i < valores.length; i++) {
    var r = valores[i];
    var titulo = String(r[cT]).trim();
    if (!titulo) continue;
    var unidade = String(r[cU]).trim();
    if (!unidade || excluidas.indexOf(unidade) > -1) continue;
    // regra de "não reenviar": só entra título ainda vencido, sem recebimento/baixa e fora da aba Pagos
    if (String(r[cSit]).trim().toLowerCase() !== 'vencido') continue;
    if (paraNumero_(r[cR]) > 0) continue;
    if (cB > -1 && String(r[cB]).trim()) continue;
    if (pagos[titulo]) continue;
    var vcto = paraData_(r[cV]);
    if (!vcto) continue;
    var atraso = diasEntre_(vcto, hoje);
    if (atraso < 1) continue; // ainda não venceu
    (out[unidade] = out[unidade] || []).push({
      vcto: vcto, titulo: titulo, aluno: String(r[cS]).trim(),
      valor: paraNumero_(r[cP]), atraso: atraso, descricao: cD > -1 ? String(r[cD]).trim() : '', linha: r
    });
  }
  Object.keys(out).forEach(function (u) {
    out[u].sort(function (a, b) { return a.vcto - b.vcto || a.aluno.localeCompare(b.aluno); });
  });
  return out;
}

function resumir_(itens) {
  var total = 0, faixas = AGING_FAIXAS.map(function (f) { return { rotulo: f.rotulo, qtd: 0, valor: 0 }; });
  var maxAtraso = 0;
  itens.forEach(function (t) {
    total += t.valor;
    if (t.atraso > maxAtraso) maxAtraso = t.atraso;
    for (var k = 0; k < AGING_FAIXAS.length; k++) {
      if (t.atraso >= AGING_FAIXAS[k].min && t.atraso <= AGING_FAIXAS[k].max) { faixas[k].qtd++; faixas[k].valor += t.valor; break; }
    }
  });
  return { total: total, qtd: itens.length, media: itens.length ? total / itens.length : 0, maxAtraso: maxAtraso, faixas: faixas };
}

function corAtraso_(d) { return d > 60 ? '#b71c1c' : d > 30 ? '#e65100' : d > 15 ? '#f9a825' : '#2e7d32'; }

function renderCard_(ctx) {
  var s = resumir_(ctx.itens);
  var maxF = Math.max.apply(null, s.faixas.map(function (f) { return f.valor; }).concat([1]));
  var td = 'padding:8px 10px;border-bottom:1px solid #eceff4;font-size:12px;color:#1f2937;';
  var box = function (rot, val, sub, cor, bg, borda) {
    return '<td width="25%" style="padding:4px;"><div style="background:' + bg + ';border:1px solid ' + borda + ';border-radius:8px;padding:12px 10px;">' +
      '<div style="font-size:9px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;">' + rot + '</div>' +
      '<div style="font-size:18px;font-weight:700;color:' + cor + ';margin:4px 0;">' + val + '</div>' +
      '<div style="font-size:10px;color:#6b7280;">' + sub + '</div></div></td>';
  };
  var aging = s.faixas.map(function (f) {
    var w = Math.round(f.valor / maxF * 100);
    var pct = s.total ? (f.valor / s.total * 100).toFixed(1).replace('.', ',') + '%' : '0,0%';
    return '<tr><td style="' + td + '">' + f.rotulo + '</td>' +
      '<td align="center" style="' + td + '">' + f.qtd + '</td>' +
      '<td align="right" style="' + td + 'font-weight:600;">' + fmtBRL_(f.valor) + '</td>' +
      '<td align="right" style="' + td + 'color:#6b7280;">' + pct + '</td>' +
      '<td width="26%" style="' + td + '"><div style="background:#e5e7eb;border-radius:4px;height:8px;"><div style="background:#1976d2;height:8px;border-radius:4px;width:' + w + '%;"></div></div></td></tr>';
  }).join('');
  var linhas = ctx.itens.map(function (t, i) {
    var bg = i % 2 ? '#fafbfd' : '#ffffff';
    return '<tr style="background:' + bg + ';"><td style="' + td + '">' + fmtData_(t.vcto) + '</td>' +
      '<td style="' + td + '">' + esc_(t.titulo) + '</td>' +
      '<td style="' + td + '">' + esc_(t.aluno) + '<div style="font-size:10px;color:#9ca3af;">' + esc_(t.descricao) + '</div></td>' +
      '<td align="right" style="' + td + 'font-weight:600;">' + fmtBRL_(t.valor) + '</td>' +
      '<td align="center" style="' + td + 'font-weight:700;color:' + corAtraso_(t.atraso) + ';">' + t.atraso + 'd</td></tr>';
  }).join('');
  var th = 'padding:9px 10px;font-size:11px;color:#ffffff;font-weight:600;';

  return '<div style="background:#eef1f6;padding:20px 8px;font-family:Segoe UI,Arial,sans-serif;">' +
    '<table role="presentation" align="center" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dbe1ea;">' +
    // cabeçalho (texto à esquerda, logo à direita)
    '<tr><td bgcolor="#1a3fa8" style="background:#1a3fa8;background-image:linear-gradient(135deg,#1a237e,#1976d2);padding:22px 28px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td valign="middle">' +
        '<div style="font-size:11px;letter-spacing:3px;color:#a8c7ff;font-weight:600;">FINANCEIRO BRASAS</div>' +
        '<div style="font-size:24px;font-weight:700;color:#ffffff;margin:6px 0 2px;">' + esc_(ctx.escola) + '</div>' +
        '<div style="font-size:13px;color:#d6e4ff;">Títulos vencidos em aberto · Ref. ' + esc_(ctx.aba) + '</div></td>' +
      '<td valign="middle" align="right" width="130">' +
        '<div style="background:#ffffff;border-radius:10px;padding:8px 10px;width:110px;text-align:center;">' +
        (ctx.logoSrc ? '<img src="' + ctx.logoSrc + '" alt="BRASAS English Course" width="100" style="display:block;width:100px;height:auto;border:0;margin:0 auto;">'
                     : '<div style="font-size:22px;font-weight:800;color:#1a237e;letter-spacing:1px;">BRASAS</div><div style="font-size:8px;letter-spacing:2px;color:#1a237e;">ENGLISH COURSE</div>') +
        '</div></td>' +
      '</tr></table></td></tr>' +
    // faixa
    '<tr><td bgcolor="#1e40af" style="background:#1e3a8a;padding:11px 28px;font-size:13px;color:#ffffff;">Posição em <b>' + fmtData_(ctx.hoje) + '</b>: <b>' + s.qtd + '</b> título(s) em aberto somando <b>' + fmtBRL_(s.total) + '</b>. Solicitamos análise e retorno sobre as tratativas.</td></tr>' +
    // KPIs
    '<tr><td style="padding:18px 24px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      box('Total em aberto', fmtBRL_(s.total), s.qtd + ' título(s)', '#b71c1c', '#fff5f5', '#f5c2c2') +
      box('Média por título', fmtBRL_(s.media), 'valor previsto médio', '#111827', '#f8f9fb', '#dfe3ea') +
      box('Maior atraso', s.maxAtraso + ' dias', 'título mais antigo', '#e65100', '#fff8f0', '#f6d3b0') +
      box('Títulos', String(s.qtd), 'aguardando análise', '#1565c0', '#f8f9fb', '#dfe3ea') +
    '</tr></table></td></tr>' +
    // aging
    '<tr><td style="padding:14px 28px 4px;font-size:11px;letter-spacing:1px;color:#6b7280;font-weight:700;">AGING DOS TÍTULOS EM ABERTO</td></tr>' +
    '<tr><td style="padding:6px 24px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceff4;border-radius:8px;">' +
      '<tr style="background:#1a237e;"><td style="' + th + '">Faixa</td><td align="center" style="' + th + '">Títulos</td><td align="right" style="' + th + '">Valor</td><td align="right" style="' + th + '">% do total</td><td style="' + th + '"></td></tr>' + aging +
    '</table></td></tr>' +
    // detalhe
    '<tr><td style="padding:10px 28px 4px;font-size:11px;letter-spacing:1px;color:#6b7280;font-weight:700;">DETALHAMENTO</td></tr>' +
    '<tr><td style="padding:6px 24px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceff4;">' +
      '<tr style="background:#1a237e;"><td style="' + th + '">Vencimento</td><td style="' + th + '">Título</td><td style="' + th + '">Aluno</td><td align="right" style="' + th + '">Valor previsto</td><td align="center" style="' + th + '">Atraso</td></tr>' + linhas +
      '<tr style="background:#eef2ff;"><td colspan="3" style="' + td + 'font-weight:700;">Total</td><td align="right" style="' + td + 'font-weight:700;">' + fmtBRL_(s.total) + '</td><td style="' + td + '"></td></tr>' +
    '</table></td></tr>' +
    // botão da planilha da escola
    (ctx.link ? '<tr><td align="center" style="padding:0 28px 18px;"><a href="' + ctx.link + '" style="display:inline-block;background:#1a237e;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;padding:12px 26px;border-radius:8px;">Abrir minha planilha e registrar observações</a>' +
      '<div style="font-size:11px;color:#6b7280;margin-top:8px;">Preencha status, previsão de pagamento e observação de cada título.</div></td></tr>' : '') +
    // rodapé
    '<tr><td style="padding:0 28px 22px;font-size:11px;color:#6b7280;line-height:1.5;border-top:1px solid #eceff4;padding-top:14px;">' +
      'Atraso contado em dias corridos desde o vencimento. Títulos pagos deixam de aparecer automaticamente nas próximas posições. ' +
      'Dados extraídos em ' + fmtData_(ctx.hoje) + '. Dúvidas: financeiro BRASAS.</td></tr>' +
    '</table></div>';
}

function assuntoCard_(ctx) {
  return 'Financeiro BRASAS | Inadimplência ' + (ctx.unidade || ctx.escola) + ' - ' + ctx.aba;
}


/**
 * Resumo aberto x pago por mês (e por unidade). "Pago" = título na aba Pagos, ou com Situação Recebido/Pago, ou com valor recebido.
 * unidadeFiltro: nome da unidade (resumo de uma escola) ou null (todas).
 */
function agregarResumo_(valoresPorMes, pagosSet, excluidas, unidadeFiltro) {
  var meses = Object.keys(valoresPorMes).sort(function (a, b) { return a.split('/').reverse().join('').localeCompare(b.split('/').reverse().join('')); });
  var outMeses = [], outDet = [];
  meses.forEach(function (mes) {
    var v = valoresPorMes[mes]; if (!v.length) return;
    var h = v[0].map(function (x) { return String(x).trim(); });
    var cT = h.indexOf('Título'), cU = h.indexOf('Unidade'), cP = h.indexOf('Vl. prev.'), cR = h.indexOf('Vl. receb.'), cS = h.indexOf('Situação');
    var porU = {}, tm = { mes: mes, tq: 0, tv: 0, aq: 0, av: 0, pq: 0, pv: 0 };
    for (var i = 1; i < v.length; i++) {
      var r = v[i], t = String(r[cT]).trim(); if (!t) continue;
      var u = String(r[cU]).trim();
      if (!u || excluidas.indexOf(u) > -1) continue;
      if (unidadeFiltro && u !== unidadeFiltro) continue;
      var val = paraNumero_(r[cP]), sit = String(r[cS]).trim().toLowerCase();
      var pago = !!pagosSet[t] || sit === 'recebido' || sit === 'pago' || sit === 'liquidado' || paraNumero_(r[cR]) > 0;
      var d = porU[u] = porU[u] || { mes: mes, unidade: u, tq: 0, tv: 0, aq: 0, av: 0, pq: 0, pv: 0 };
      [d, tm].forEach(function (x) { x.tq++; x.tv += val; if (pago) { x.pq++; x.pv += val; } else { x.aq++; x.av += val; } });
    }
    if (tm.tq) { outMeses.push(tm); Object.keys(porU).sort().forEach(function (u) { outDet.push(porU[u]); }); }
  });
  return { meses: outMeses, detalhe: outDet };
}

if (typeof module !== 'undefined') {
  module.exports = { agruparAbertosPorUnidade_: agruparAbertosPorUnidade_, resumir_: resumir_, renderCard_: renderCard_, assuntoCard_: assuntoCard_, agregarResumo_: agregarResumo_, fmtBRL_: fmtBRL_, paraNumero_: paraNumero_ };
}

/* ===================== PARTE GOOGLE (menu, planilhas das escolas, Gmail, gatilhos) ===================== */

var ABA_CONFIG = 'Config', ABA_PAGOS = 'Pagos', ABA_LOG = 'Log_Envios', ABA_RESUMO = 'Resumo', ABA_REGULARIZADOS = 'Regularizados';
var REGEX_ABA_MES = /^(0[1-9]|1[0-2])\/\d{4}$/;
var PASTA_PADRAO = '14HA3AWHnMDZZ691CDT9UIV8bS9_kM8DR';
var ADMINS_PADRAO = ['renatadahora@brasas.com', 'isabelamoura@brasas.com', 'bruno@brasas.com', 'adriane@brasas.com'];
var LIMITE_MS = 250000; // pausa antes do limite de 6 min do Apps Script e continua sozinho
var COLS_EXTRAS = ['Dias de atraso', 'Status (escola)', 'Previsão de pagamento', 'Observação da escola', 'Retorno do Financeiro'];
var STATUS_ESCOLA = ['Em contato com o responsável', 'Promessa de pagamento', 'Pagamento em análise',
                     'Negociação / acordo', 'Aluno inativo / cancelado', 'Sem retorno do responsável', 'Outro'];
var COLS_DATA_ = ['Vcto', 'Emissão', 'Dt. crédito', 'Dt. baixa', 'Dt. agendamento', 'Envio RPS', 'Data NFSe'];
var COLS_VALOR_ = ['Vl. prev.', 'Vl. receb.'];
var COLS_INTEIRO_ = ['Índice', 'Título', 'Fatura'];
var AZUL = '#1a237e', AZUL2 = '#1976d2', AMARELO = '#fff8e1';

// Logo BRASAS embutida (PNG pequeno), usada como imagem inline no e-mail. Nao depende de arquivo no Drive.
var LOGO_B64 = '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';
function logoBlob_() { return Utilities.newBlob(Utilities.base64Decode(LOGO_B64), 'image/png', 'logo_brasas_email.png'); }

/* ---------- menu e ajuda ---------- */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Financeiro BRASAS')
    .addItem('1. Atualizar tudo agora (pagos, escolas e resumos)', 'atualizarTudo')
    .addItem('2. Enviar cards por e-mail (escolher o mês)', 'abrirSeletor')
    .addSeparator()
    .addItem('Dar baixa nos pagos (preenche colunas H, L e I)', 'darBaixaPagos')
    .addItem('Atualizar só o Resumo desta planilha', 'atualizarResumoMaster')
    .addSeparator()
    .addSubMenu(ui.createMenu('Configuração')
      .addItem('Preparar aba Config (escolas, e-mails, modo)', 'prepararConfig')
      .addItem('Ligar rotina automática', 'instalarGatilho')
      .addItem('Desligar rotina automática', 'removerGatilho'))
    .addItem('Ajuda: o que cada botão faz', 'mostrarAjuda')
    .addToUi();
}

function mostrarAjuda() {
  var h = '<div style="font-family:Arial;font-size:13px;line-height:1.5;padding:6px 10px;color:#1f2937">' +
    '<p><b>1. Atualizar tudo agora</b><br>Faz a rotina completa, na ordem: dá baixa nos pagos (H, L e I), atualiza o Resumo desta planilha e atualiza a planilha de cada escola no Drive (abas dos meses, Regularizados e Resumo). Use depois de colar dados novos na aba do mês ou na aba Pagos. Não envia e-mail.</p>' +
    '<p><b>2. Enviar cards por e-mail</b><br>Você escolhe a aba do mês e o script envia um card por escola. O modo (Rascunho, Teste ou Produção) fica na aba Config, célula B1. Em Rascunho os e-mails vão para o seu rascunho do Gmail e nada é enviado.</p>' +
    '<p><b>Dar baixa nos pagos</b><br>Para cada título da aba Pagos: preenche H (valor recebido, igual ao valor previsto se estiver vazio), L (data de crédito, usa a Dt. baixa ou a data de hoje se estiver vazia) e troca I de Vencido para Recebido. Faz o mesmo nas linhas do mês. Só mexe em quem ainda está como Vencido.</p>' +
    '<p><b>Atualizar só o Resumo desta planilha</b><br>Recalcula a aba Resumo (em aberto x pago, com percentual, por mês e por unidade), sem mexer nas escolas.</p>' +
    '<p><b>Configuração > Preparar aba Config</b><br>Cria ou completa a aba Config com o modo, os dias de envio, as unidades excluídas, a pasta do Drive, os e-mails autorizados e a lista de escolas com o e-mail do gerente. Rode uma vez e sempre que surgir uma unidade nova.</p>' +
    '<p><b>Configuração > Ligar rotina automática</b><br>Liga dois gatilhos: uma verificação a cada hora, que só atualiza se a planilha mudou, e um envio de cards às 08h nos dias definidos em Config, B3.</p>' +
    '<p><b>Configuração > Desligar rotina automática</b><br>Remove os gatilhos. Os botões manuais continuam funcionando.</p>' +
    '</div>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(h).setWidth(560).setHeight(520), 'Financeiro BRASAS: o que cada botão faz');
}

/* ---------- configuração ---------- */

function listarAbasMes_() {
  return SpreadsheetApp.getActive().getSheets().map(function (s) { return s.getName(); })
    .filter(function (n) { return REGEX_ABA_MES.test(n); })
    .sort(function (a, b) { return a.split('/').reverse().join('').localeCompare(b.split('/').reverse().join('')); });
}

function lerConfig_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(ABA_CONFIG);
  if (!sh) { prepararConfig(); sh = SpreadsheetApp.getActive().getSheetByName(ABA_CONFIG); }
  var v = sh.getRange('B1:B7').getValues();
  var escolas = {};
  var dados = sh.getLastRow() >= 9 ? sh.getRange(9, 1, sh.getLastRow() - 8, 4).getValues() : [];
  dados.forEach(function (r) {
    if (r[0]) escolas[String(r[0]).trim()] = { nome: r[1], email: r[2], ativo: String(r[3]).toUpperCase() !== 'NÃO' && String(r[3]).toUpperCase() !== 'NAO' };
  });
  var admins = String(v[6][0] || '').split(/[;,\s]+/).filter(String);
  return {
    modo: String(v[0][0] || 'RASCUNHO').toUpperCase(),
    destino: String(v[1][0] || 'renatadahora@brasas.com'),
    dias: String(v[2][0] || '10,25').split(',').map(function (x) { return parseInt(x, 10); }),
    excluidas: String(v[3][0] || 'Professores').split(',').map(function (x) { return x.trim(); }),
    pastaId: String(v[5][0] || PASTA_PADRAO).trim(),
    admins: admins.length ? admins : ADMINS_PADRAO,
    escolas: escolas
  };
}

/** Cria a aba Config e completa o que faltar, sem apagar o que ja esta preenchido. */
function prepararConfig() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(ABA_CONFIG) || ss.insertSheet(ABA_CONFIG);
  var padrao = [
    ['MODO (RASCUNHO / TESTE / PRODUCAO)', 'RASCUNHO'],
    ['DESTINO_TESTE', 'renatadahora@brasas.com'],
    ['DIAS_ENVIO (dias do mês, separados por vírgula)', '10,25'],
    ['UNIDADES_EXCLUIDAS', 'Professores'],
    ['(livre, não usado)', ''],
    ['PASTA_ESCOLAS_ID (pasta Inadimplência Escolas)', PASTA_PADRAO],
    ['EMAILS_AUTORIZADOS (podem editar tudo nas planilhas das escolas)', ADMINS_PADRAO.join(', ')]
  ];
  padrao.forEach(function (l, i) {
    if (!sh.getRange(i + 1, 1).getValue()) sh.getRange(i + 1, 1, 1, 2).setValues([l]);
    else if (i === 6 && !sh.getRange(i + 1, 2).getValue()) sh.getRange(i + 1, 2).setValue(l[1]);
  });
  sh.getRange('A8:D8').setValues([['Unidade (igual à planilha)', 'Nome da escola', 'E-mail do gerente', 'Ativo (SIM/NÃO)']]).setFontWeight('bold');
  sh.setColumnWidths(1, 4, 260);
  var abas = listarAbasMes_();
  if (!abas.length) return;
  var un = {};
  abas.forEach(function (m) {
    var a = ss.getSheetByName(m), vals = a.getDataRange().getValues(), c = vals[0].map(function (x) { return String(x).trim(); }).indexOf('Unidade');
    if (c > -1) vals.slice(1).forEach(function (r) { var u = String(r[c]).trim(); if (u) un[u] = true; });
  });
  var existentes = {};
  if (sh.getLastRow() >= 9) sh.getRange(9, 1, sh.getLastRow() - 8, 1).getValues().forEach(function (r) { existentes[String(r[0]).trim()] = true; });
  var novas = Object.keys(un).sort().filter(function (u) { return !existentes[u]; }).map(function (u) { return [u, 'BRASAS ' + u, '', 'SIM']; });
  if (novas.length) sh.getRange(Math.max(sh.getLastRow() + 1, 9), 1, novas.length, 4).setValues(novas);
}

/* ---------- leitura da planilha mestre ---------- */

function cabTrim_(linha) { return linha.map(function (x) { return String(x).trim(); }); }

function carregarMestre_(cfg) {
  var ss = SpreadsheetApp.getActive(), hoje = new Date();
  var meses = listarAbasMes_(), valoresPorMes = {}, tituloUnidade = {};
  meses.forEach(function (m) {
    var vals = ss.getSheetByName(m).getDataRange().getValues();
    valoresPorMes[m] = vals;
    var h = cabTrim_(vals[0]), cT = h.indexOf('Título'), cU = h.indexOf('Unidade');
    vals.slice(1).forEach(function (r) { var t = String(r[cT]).trim(); if (t) tituloUnidade[t] = String(r[cU]).trim(); });
  });
  var pSh = ss.getSheetByName(ABA_PAGOS), pVals = (pSh && pSh.getLastRow() >= 1) ? pSh.getDataRange().getValues() : [];
  var pagosCab = pVals.length ? cabTrim_(pVals[0]) : (meses.length ? cabTrim_(valoresPorMes[meses[0]][0]) : []);
  var iT = pagosCab.indexOf('Título'), iU = pagosCab.indexOf('Unidade');
  var pagosRows = pVals.slice(1).filter(function (r) { return iT > -1 && String(r[iT]).trim(); });
  var pagosSet = {};
  pagosRows.forEach(function (r) { pagosSet[String(r[iT]).trim()] = true; });
  var abertos = {};
  meses.forEach(function (m) { abertos[m] = agruparAbertosPorUnidade_(valoresPorMes[m], pagosSet, cfg.excluidas, hoje); });
  return { ss: ss, hoje: hoje, meses: meses, valoresPorMes: valoresPorMes, pagosCab: pagosCab, pagosRows: pagosRows,
           pagosSet: pagosSet, abertos: abertos, tituloUnidade: tituloUnidade, iTitPagos: iT, iUniPagos: iU };
}

function unidadesAtivas_(M, cfg) {
  var un = {};
  M.meses.forEach(function (m) { Object.keys(M.abertos[m]).forEach(function (u) { un[u] = true; }); });
  M.pagosRows.forEach(function (r) {
    var u = M.iUniPagos > -1 ? String(r[M.iUniPagos]).trim() : '';
    if (!u) u = M.tituloUnidade[String(r[M.iTitPagos]).trim()] || '';
    if (u && cfg.excluidas.indexOf(u) < 0) un[u] = true;
  });
  return Object.keys(un).filter(function (u) { var e = cfg.escolas[u]; return !e || e.ativo; }).sort();
}

/* ---------- baixa dos pagos: preenche H (valor), L (data de credito) e I (Recebido) ---------- */

function darBaixaPagos() {
  var ss = SpreadsheetApp.getActive(), hoje = new Date();
  var hojeData = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  var pSh = ss.getSheetByName(ABA_PAGOS);
  if (!pSh || pSh.getLastRow() < 2) return 'Aba Pagos vazia, nada a baixar.';
  var v = pSh.getDataRange().getValues(), h = cabTrim_(v[0]);
  var cT = h.indexOf('Título'), cPrev = h.indexOf('Vl. prev.'), cRec = h.indexOf('Vl. receb.'), cSit = h.indexOf('Situação'),
      cCred = h.indexOf('Dt. crédito'), cBaixa = h.indexOf('Dt. baixa');
  if ([cT, cPrev, cRec, cSit, cCred].some(function (c) { return c < 0; })) throw new Error('Aba Pagos sem as colunas Título, Vl. prev., Vl. receb., Situação e Dt. crédito.');
  var n = v.length - 1, H = [], I = [], L = [], mapa = {}, mudou = 0;
  for (var i = 1; i < v.length; i++) {
    var r = v[i], t = String(r[cT]).trim();
    var rec = r[cRec], sit = r[cSit], cred = r[cCred];
    if (t) {
      var novoRec = (rec === '' || rec === null || paraNumero_(rec) === 0) ? r[cPrev] : rec;
      var novaData = cred;
      if (cred === '' || cred === null) {
        var b = cBaixa > -1 ? paraData_(r[cBaixa]) : null;
        novaData = b || hojeData;
      }
      var novaSit = 'Recebido';
      if (novoRec !== rec || novaData !== cred || novaSit !== sit) mudou++;
      H.push([novoRec]); L.push([novaData]); I.push([novaSit]);
      mapa[t] = { rec: novoRec, data: novaData };
    } else { H.push([rec]); L.push([cred]); I.push([sit]); }
  }
  if (mudou) {
    pSh.getRange(2, cRec + 1, n, 1).setValues(H).setNumberFormat('R$ #,##0.00');
    pSh.getRange(2, cSit + 1, n, 1).setValues(I);
    pSh.getRange(2, cCred + 1, n, 1).setValues(L).setNumberFormat('dd/mm/yyyy');
  }
  // mesmas 3 colunas nas linhas do mes (so quem ainda esta Vencido)
  var mesesTocados = 0;
  listarAbasMes_().forEach(function (m) {
    var sh = ss.getSheetByName(m), vv = sh.getDataRange().getValues(), hh = cabTrim_(vv[0]);
    var t2 = hh.indexOf('Título'), r2 = hh.indexOf('Vl. receb.'), s2 = hh.indexOf('Situação'), c2 = hh.indexOf('Dt. crédito');
    if ([t2, r2, s2, c2].some(function (c) { return c < 0; })) return;
    var nn = vv.length - 1, H2 = [], I2 = [], L2 = [], alt = 0;
    for (var k = 1; k < vv.length; k++) {
      var row = vv[k], tt = String(row[t2]).trim(), m0 = mapa[tt];
      if (m0 && String(row[s2]).trim().toLowerCase() === 'vencido') { H2.push([m0.rec]); I2.push(['Recebido']); L2.push([m0.data]); alt++; }
      else { H2.push([row[r2]]); I2.push([row[s2]]); L2.push([row[c2]]); }
    }
    if (alt) {
      sh.getRange(2, r2 + 1, nn, 1).setValues(H2).setNumberFormat('R$ #,##0.00');
      sh.getRange(2, s2 + 1, nn, 1).setValues(I2);
      sh.getRange(2, c2 + 1, nn, 1).setValues(L2).setNumberFormat('dd/mm/yyyy');
      mesesTocados += alt;
    }
  });
  SpreadsheetApp.flush();
  return 'Baixa feita: ' + mudou + ' linha(s) ajustada(s) na aba Pagos e ' + mesesTocados + ' linha(s) marcadas como Recebido nas abas dos meses.';
}

/* ---------- Resumo (aberto x pago) ---------- */

function pct_(a, b) { return b ? a / b : 0; }

/**
 * Desenha o Resumo no estilo BRASAS: sem linhas de grade, tudo centralizado.
 * o = { titulo, subtitulo, meses:[{mes,tq,tv,aq,av,pq,pv}], detalhe:[{mes,unidade,...}] | null, ajuda:[texto] | null }
 */
function desenharResumo_(sh, o) {
  var maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
  sh.getRange(1, 1, maxR, maxC).breakApart();
  sh.clear(); sh.clearConditionalFormatRules();
  sh.setHiddenGridlines(true);
  if (sh.getMaxColumns() < 11) sh.insertColumnsAfter(sh.getMaxColumns(), 11 - sh.getMaxColumns());
  var larg = [24, 95, 140, 120, 130, 120, 130, 120, 100, 100, 170];
  larg.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });

  var tot = { tq: 0, tv: 0, aq: 0, av: 0, pq: 0, pv: 0 };
  o.meses.forEach(function (m) { ['tq', 'tv', 'aq', 'av', 'pq', 'pv'].forEach(function (k) { tot[k] += m[k]; }); });

  // banner
  var ban = sh.getRange(1, 2, 3, 10); ban.setBackground(AZUL).setHorizontalAlignment('center').setVerticalAlignment('middle');
  [1, 2, 3].forEach(function (r) { sh.getRange(r, 2, 1, 10).merge(); });
  sh.getRange(1, 2).setValue('FINANCEIRO BRASAS').setFontSize(10).setFontWeight('bold').setFontColor('#a8c7ff');
  sh.getRange(2, 2).setValue(o.titulo).setFontSize(24).setFontWeight('bold').setFontColor('#ffffff');
  sh.getRange(3, 2).setValue(o.subtitulo).setFontSize(11).setFontColor('#d6e4ff');
  sh.setRowHeight(1, 30); sh.setRowHeight(2, 46); sh.setRowHeight(3, 30); sh.setRowHeight(4, 14);

  // KPIs: 5 blocos de 2 colunas
  var kp = [
    { rot: 'VALOR TOTAL', val: tot.tv, fmt: 'R$ #,##0.00', sub: tot.tq + ' título(s)', cor: '#111827', bg: '#f8f9fb', bd: '#dfe3ea' },
    { rot: 'EM ABERTO', val: tot.av, fmt: 'R$ #,##0.00', sub: tot.aq + ' título(s)', cor: '#b71c1c', bg: '#fff5f5', bd: '#f5c2c2' },
    { rot: 'PAGO', val: tot.pv, fmt: 'R$ #,##0.00', sub: tot.pq + ' título(s)', cor: '#1b5e20', bg: '#f1f8f4', bd: '#b7dfc4' },
    { rot: '% PAGO', val: pct_(tot.pv, tot.tv), fmt: '0.0%', sub: 'do valor total', cor: '#1565c0', bg: '#f3f8ff', bd: '#c5d9f5' },
    { rot: '% EM ABERTO', val: pct_(tot.av, tot.tv), fmt: '0.0%', sub: 'do valor total', cor: '#e65100', bg: '#fff8f0', bd: '#f6d3b0' }
  ];
  kp.forEach(function (k, i) {
    var c = 2 + i * 2, bloco = sh.getRange(5, c, 3, 2);
    bloco.setBackground(k.bg).setBorder(true, true, true, true, false, false, k.bd, SpreadsheetApp.BorderStyle.SOLID).setHorizontalAlignment('center').setVerticalAlignment('middle');
    [5, 6, 7].forEach(function (r) { sh.getRange(r, c, 1, 2).merge(); });
    sh.getRange(5, c).setValue(k.rot).setFontSize(9).setFontColor('#6b7280').setFontWeight('bold');
    sh.getRange(6, c).setValue(k.val).setNumberFormat(k.fmt).setFontSize(17).setFontWeight('bold').setFontColor(k.cor);
    sh.getRange(7, c).setValue(k.sub).setFontSize(9).setFontColor('#6b7280');
  });
  sh.setRowHeight(5, 24); sh.setRowHeight(6, 38); sh.setRowHeight(7, 24); sh.setRowHeight(8, 18);

  var r = 9;
  sh.getRange(r, 2, 1, 10).merge().setValue('RESUMO POR MÊS').setFontSize(10).setFontWeight('bold').setFontColor('#6b7280').setHorizontalAlignment('center');
  r++;
  var cab = ['Mês', 'Títulos', 'Valor total', 'Em aberto (qtd)', 'Em aberto (R$)', 'Pago (qtd)', 'Pago (R$)', '% pago', '% em aberto', 'Progresso do pago'];
  sh.getRange(r, 2, 1, 10).setValues([cab]).setBackground(AZUL).setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(r, 34);
  var ini = r + 1, linhas = o.meses.map(function (m) {
    return [m.mes, m.tq, m.tv, m.aq, m.av, m.pq, m.pv, pct_(m.pv, m.tv), pct_(m.av, m.tv), ''];
  });
  linhas.push(['TOTAL', tot.tq, tot.tv, tot.aq, tot.av, tot.pq, tot.pv, pct_(tot.pv, tot.tv), pct_(tot.av, tot.tv), '']);
  if (linhas.length) {
    var rg = sh.getRange(ini, 2, linhas.length, 10);
    rg.setValues(linhas).setHorizontalAlignment('center').setVerticalAlignment('middle').setFontSize(10);
    sh.getRange(ini, 4, linhas.length, 1).setNumberFormat('R$ #,##0.00');
    sh.getRange(ini, 6, linhas.length, 1).setNumberFormat('R$ #,##0.00');
    sh.getRange(ini, 8, linhas.length, 1).setNumberFormat('R$ #,##0.00');
    sh.getRange(ini, 9, linhas.length, 2).setNumberFormat('0.0%');
    for (var i = 0; i < linhas.length; i++) {
      sh.getRange(ini + i, 2, 1, 10).setBackground(i === linhas.length - 1 ? '#e8eaf6' : (i % 2 ? '#f5f7fb' : '#ffffff'));
      sh.getRange(ini + i, 11).setFormula('=SPARKLINE(I' + (ini + i) + ',{"charttype","bar";"max",1;"color1","#1976d2"})');
      sh.setRowHeight(ini + i, 28);
    }
    sh.getRange(ini + linhas.length - 1, 2, 1, 10).setFontWeight('bold');
  }
  r = ini + linhas.length + 1;

  if (o.detalhe && o.detalhe.length) {
    sh.getRange(r, 2, 1, 10).merge().setValue('DETALHE POR UNIDADE').setFontSize(10).setFontWeight('bold').setFontColor('#6b7280').setHorizontalAlignment('center');
    r++;
    var cab2 = ['Mês', 'Unidade', 'Títulos', 'Valor total', 'Em aberto (qtd)', 'Em aberto (R$)', 'Pago (qtd)', 'Pago (R$)', '% pago', 'Progresso do pago'];
    sh.getRange(r, 2, 1, 10).setValues([cab2]).setBackground(AZUL).setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
    sh.setRowHeight(r, 34);
    var ini2 = r + 1, l2 = o.detalhe.map(function (d) { return [d.mes, d.unidade, d.tq, d.tv, d.aq, d.av, d.pq, d.pv, pct_(d.pv, d.tv), '']; });
    var rg2 = sh.getRange(ini2, 2, l2.length, 10);
    rg2.setValues(l2).setHorizontalAlignment('center').setVerticalAlignment('middle').setFontSize(10);
    sh.getRange(ini2, 5, l2.length, 1).setNumberFormat('R$ #,##0.00');
    sh.getRange(ini2, 7, l2.length, 1).setNumberFormat('R$ #,##0.00');
    sh.getRange(ini2, 9, l2.length, 1).setNumberFormat('R$ #,##0.00');
    sh.getRange(ini2, 10, l2.length, 1).setNumberFormat('0.0%');
    var bg2 = []; for (var j = 0; j < l2.length; j++) bg2.push(Array(10).fill(j % 2 ? '#f5f7fb' : '#ffffff'));
    rg2.setBackgrounds(bg2);
    for (var j2 = 0; j2 < l2.length; j2++) sh.getRange(ini2 + j2, 11).setFormula('=SPARKLINE(J' + (ini2 + j2) + ',{"charttype","bar";"max",1;"color1","#1976d2"})');
    r = ini2 + l2.length + 1;
  }

  if (o.ajuda && o.ajuda.length) {
    sh.getRange(r, 2, 1, 10).merge().setValue('COMO USAR ESTA PLANILHA').setFontSize(10).setFontWeight('bold').setFontColor('#6b7280').setHorizontalAlignment('center');
    r++;
    o.ajuda.forEach(function (t, k) {
      var cel = sh.getRange(r + k, 2, 1, 10); cel.merge().setValue(t).setWrap(true).setHorizontalAlignment('center').setVerticalAlignment('middle')
        .setBackground(k % 2 ? '#fff8e1' : '#fffbee').setFontSize(10).setFontColor('#374151');
      sh.setRowHeight(r + k, 30);
    });
    r += o.ajuda.length;
  }
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setFontFamily('Arial');
  if (sh.getMaxRows() > r + 1) sh.deleteRows(r + 2, sh.getMaxRows() - (r + 1));
  if (sh.getMaxColumns() > 12) sh.deleteColumns(13, sh.getMaxColumns() - 12);
  sh.setFrozenRows(0); sh.setFrozenColumns(0);
}

function atualizarResumoMaster() {
  var cfg = lerConfig_(), M = carregarMestre_(cfg), ss = M.ss;
  var ag = agregarResumo_(M.valoresPorMes, M.pagosSet, cfg.excluidas, null);
  var sh = ss.getSheetByName(ABA_RESUMO) || ss.insertSheet(ABA_RESUMO);
  desenharResumo_(sh, {
    titulo: 'Resumo de inadimplência: aberto x pago', subtitulo: 'Todas as unidades, por mês. Atualizado em ' + fmtData_(M.hoje),
    meses: ag.meses, detalhe: ag.detalhe, ajuda: null
  });
  ss.setActiveSheet(sh); ss.moveActiveSheet(1);
  return 'Resumo atualizado.';
}

/* ---------- planilha de cada escola ---------- */

function acharArquivo_(pasta, titulo) {
  var it = pasta.getFilesByName(titulo);
  return it.hasNext() ? it.next() : null;
}

// Compartilha arquivo ou pasta como editor SEM enviar e-mail de aviso (Drive API v3 via UrlFetchApp).
function compartilharSemAviso_(id, emails) {
  var token = ScriptApp.getOAuthToken();
  emails.forEach(function (m) {
    m = String(m || '').trim();
    if (!m) return;
    try {
      var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id +
        '/permissions?sendNotificationEmail=false&supportsAllDrives=true', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ type: 'user', role: 'writer', emailAddress: m })
      });
      if (r.getResponseCode() >= 300) registrarErro_('Compartilhar sem aviso falhou para ' + m + ': ' + r.getContentText().slice(0, 200));
    } catch (e) { registrarErro_('Compartilhar sem aviso falhou para ' + m + ': ' + e.message); }
  });
}

function protegerSheet_(sh, admins, livre) {
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) { p.remove(); });
  var p = sh.protect().setDescription('Protegida pelo Financeiro BRASAS');
  if (livre) p.setUnprotectedRanges([livre]);
  try { p.removeEditors(p.getEditors()); } catch (e) {}
  try { p.addEditors(admins); } catch (e) { registrarErro_('Proteção: não consegui adicionar editores autorizados em "' + sh.getName() + '": ' + e.message); }
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

function ajustarTamanho_(sh, linhas, colunas) {
  if (sh.getMaxRows() > linhas) sh.deleteRows(linhas + 1, sh.getMaxRows() - linhas);
  else if (sh.getMaxRows() < linhas) sh.insertRowsAfter(sh.getMaxRows(), linhas - sh.getMaxRows());
  if (sh.getMaxColumns() > colunas) sh.deleteColumns(colunas + 1, sh.getMaxColumns() - colunas);
  else if (sh.getMaxColumns() < colunas) sh.insertColumnsAfter(sh.getMaxColumns(), colunas - sh.getMaxColumns());
}

var NOMES_LEGADOS_ = ['Untitled', 'Sheet1', 'Planilha1', 'Página1', 'Títulos em aberto'];

/** Escreve a aba de um mês (MM/AAAA) da escola, preservando o que a escola preencheu em AB:AD e AE. */
function escreverAbaMes_(ss, mes, cab, itens, hoje, admins, ehPrimeira) {
  var sh = ss.getSheetByName(mes);
  if (!sh && ehPrimeira) {
    var leg = ss.getSheets().filter(function (s) { return NOMES_LEGADOS_.indexOf(s.getName()) > -1; })[0];
    if (leg) { sh = leg; sh.setName(mes); }
  }
  if (!sh) sh = ss.insertSheet(mes);
  var nOrig = cab.length, nTot = nOrig + COLS_EXTRAS.length;
  var iTit = cab.indexOf('Título'), cAtraso = nOrig, cStatus = nOrig + 1, cPrev = nOrig + 2, cObs = nOrig + 3, cRet = nOrig + 4;

  // guarda o que ja existe (busca pelo NOME da coluna)
  var antigo = {}, ult = sh.getLastRow(), lc = sh.getLastColumn();
  if (ult >= 2 && lc > 0) {
    var hA = cabTrim_(sh.getRange(1, 1, 1, lc).getValues()[0]);
    var cT = hA.indexOf('Título'), cS = hA.indexOf('Status (escola)'), cP = hA.indexOf('Previsão de pagamento'),
        cO = hA.indexOf('Observação da escola'), cR = hA.indexOf('Retorno do Financeiro');
    if (cT > -1) sh.getRange(2, 1, ult - 1, lc).getValues().forEach(function (r) {
      var t = String(r[cT]).trim(); if (!t) return;
      antigo[t] = { st: cS > -1 ? r[cS] : '', pr: cP > -1 ? r[cP] : '', ob: cO > -1 ? r[cO] : '', rt: cR > -1 ? r[cR] : '' };
    });
  }
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) { p.remove(); });
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear(); sh.clearConditionalFormatRules();
  var n = itens.length;
  sh.setFrozenRows(0); sh.setFrozenColumns(0);
  ajustarTamanho_(sh, Math.max(n + 1, 2), nTot);
  sh.setHiddenGridlines(true);

  var linhas = itens.map(function (t) {
    var a = antigo[t.titulo] || {};
    var base = cab.map(function (_, k) { return t.linha[k] === undefined ? '' : t.linha[k]; });
    return base.concat([t.atraso, a.st || '', a.pr || '', a.ob || '', a.rt || '']);
  });
  var todo = sh.getRange(1, 1, Math.max(n + 1, 2), nTot);
  todo.setFontFamily('Arial').setFontSize(10).setHorizontalAlignment('center').setVerticalAlignment('middle');
  var hd = sh.getRange(1, 1, 1, nTot);
  hd.setValues([cab.concat(COLS_EXTRAS)]).setFontWeight('bold').setFontColor('#ffffff').setBackground(AZUL).setWrap(true);
  sh.getRange(1, cStatus + 1, 1, 4).setBackground('#f9a825').setFontColor('#000000');
  sh.setRowHeight(1, 40);
  if (n) {
    sh.getRange(2, 1, n, nTot).setValues(linhas);
    var bg = []; for (var i = 0; i < n; i++) bg.push(Array(nOrig + 1).fill(i % 2 ? '#f5f7fb' : '#ffffff').concat(Array(4).fill(AMARELO)));
    sh.getRange(2, 1, n, nTot).setBackgrounds(bg);
    cab.forEach(function (nome, k) {
      var col = sh.getRange(2, k + 1, n, 1);
      if (COLS_DATA_.indexOf(nome) > -1) col.setNumberFormat('dd/mm/yyyy');
      else if (COLS_VALOR_.indexOf(nome) > -1) col.setNumberFormat('R$ #,##0.00');
      else if (COLS_INTEIRO_.indexOf(nome) > -1) col.setNumberFormat('0');
    });
    sh.getRange(2, cPrev + 1, n, 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(2, cObs + 1, n, 1).setWrap(true);
  }
  sh.getRange(2, cStatus + 1, Math.max(n, 1), 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUS_ESCOLA, true).setAllowInvalid(true).build());
  sh.setFrozenRows(1); sh.setFrozenColumns(iTit + 2);
  cab.forEach(function (nome, k) { sh.setColumnWidth(k + 1, nome === 'Sacado' ? 250 : nome === 'Descrição' ? 190 : 105); });
  sh.setColumnWidth(cAtraso + 1, 95); sh.setColumnWidth(cStatus + 1, 210); sh.setColumnWidth(cPrev + 1, 150); sh.setColumnWidth(cObs + 1, 340); sh.setColumnWidth(cRet + 1, 260);
  protegerSheet_(sh, admins, sh.getRange(2, cStatus + 1, Math.max(n, 1), 4));
  return sh;
}

function escreverRegularizados_(ss, cabPagos, linhas, admins) {
  var sh = ss.getSheetByName(ABA_REGULARIZADOS) || ss.insertSheet(ABA_REGULARIZADOS);
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) { p.remove(); });
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  var n = linhas.length, nC = cabPagos.length;
  sh.setFrozenRows(0); sh.setFrozenColumns(0);
  ajustarTamanho_(sh, Math.max(n + 1, 2), nC);
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, Math.max(n + 1, 2), nC).setFontFamily('Arial').setFontSize(10).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(1, 1, 1, nC).setValues([cabPagos]).setFontWeight('bold').setFontColor('#ffffff').setBackground('#1b5e20').setWrap(true);
  sh.setRowHeight(1, 40);
  if (n) {
    sh.getRange(2, 1, n, nC).setValues(linhas);
    var bg = []; for (var i = 0; i < n; i++) bg.push(Array(nC).fill(i % 2 ? '#f1f8f4' : '#ffffff'));
    sh.getRange(2, 1, n, nC).setBackgrounds(bg);
    cabPagos.forEach(function (nome, k) {
      var col = sh.getRange(2, k + 1, n, 1);
      if (COLS_DATA_.indexOf(nome) > -1) col.setNumberFormat('dd/mm/yyyy');
      else if (COLS_VALOR_.indexOf(nome) > -1) col.setNumberFormat('R$ #,##0.00');
      else if (COLS_INTEIRO_.indexOf(nome) > -1) col.setNumberFormat('0');
    });
  }
  sh.setFrozenRows(1);
  cabPagos.forEach(function (nome, k) { sh.setColumnWidth(k + 1, nome === 'Sacado' ? 250 : nome === 'Descrição' ? 190 : 105); });
  protegerSheet_(sh, admins, null);
  return sh;
}

/**
 * Atualiza o arquivo da escola: uma aba por mês (MM/AAAA) com os títulos em aberto, a aba Regularizados
 * (mesmo cabeçalho da aba Pagos) e o Resumo BRASAS. Preserva o que a escola preencheu em AB:AE.
 * Retorna { arq, gids: { 'MM/AAAA': gid } }.
 */
function sincronizarPlanilhaEscola_(unidade, M, cfg) {
  var pasta = DriveApp.getFolderById(cfg.pastaId);
  compartilharSemAviso_(pasta.getId(), cfg.admins);   // e-mails autorizados entram pela pasta, sem aviso
  var titulo = 'Inadimplência - ' + unidade;
  var arq = acharArquivo_(pasta, titulo);
  if (!arq) { arq = DriveApp.getFileById(SpreadsheetApp.create(titulo).getId()); arq.moveTo(pasta); }
  try { arq.setShareableByEditors(false); } catch (e) {}
  var ss = SpreadsheetApp.openById(arq.getId()), gids = {};

  M.meses.forEach(function (mes, k) {
    var cab = cabTrim_(M.valoresPorMes[mes][0]);
    var sh = escreverAbaMes_(ss, mes, cab, M.abertos[mes][unidade] || [], M.hoje, cfg.admins, k === 0);
    gids[mes] = sh.getSheetId();
  });
  var linhasPagas = M.pagosRows.filter(function (r) {
    var u = M.iUniPagos > -1 ? String(r[M.iUniPagos]).trim() : '';
    if (!u) u = M.tituloUnidade[String(r[M.iTitPagos]).trim()] || '';
    return u === unidade;
  });
  escreverRegularizados_(ss, M.pagosCab, linhasPagas, cfg.admins);

  var ag = agregarResumo_(M.valoresPorMes, M.pagosSet, cfg.excluidas, unidade);
  var esc = cfg.escolas[unidade] || { nome: 'BRASAS ' + unidade };
  var rs = ss.getSheetByName(ABA_RESUMO) || ss.insertSheet(ABA_RESUMO);
  rs.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  desenharResumo_(rs, {
    titulo: esc.nome, subtitulo: 'Resumo de inadimplência. Atualizado em ' + fmtData_(M.hoje),
    meses: ag.meses, detalhe: null,
    ajuda: ['1. Abra a aba do mês (exemplo: ' + (M.meses[M.meses.length - 1] || '09/2026') + ') para ver os títulos em aberto.',
            '2. Preencha somente as colunas amarelas: Status, Previsão de pagamento, Observação e Retorno (AB a AE).',
            '3. Títulos pagos saem da lista do mês sozinhos e aparecem na aba Regularizados.',
            '4. Não é possível incluir, excluir ou alterar linhas e colunas. Em caso de dúvida, fale com o Financeiro BRASAS.']
  });
  protegerSheet_(rs, cfg.admins, null);

  // ordem das abas: Resumo, meses, Regularizados; remove abas legadas vazias
  var ordem = [ABA_RESUMO].concat(M.meses, [ABA_REGULARIZADOS]);
  ordem.forEach(function (nome, i) { var s = ss.getSheetByName(nome); if (s) { ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); } });
  ss.setActiveSheet(ss.getSheetByName(ABA_RESUMO));
  ss.getSheets().forEach(function (s) {
    if (ordem.indexOf(s.getName()) < 0 && NOMES_LEGADOS_.indexOf(s.getName()) > -1 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  // acesso: somente a propria escola, e apenas em PRODUCAO
  var e = cfg.escolas[unidade];
  if (cfg.modo === 'PRODUCAO' && e && e.email) {
    compartilharSemAviso_(arq.getId(), String(e.email).split(/[;,\s]+/).filter(String));
  }
  return { arq: arq, gids: gids };
}

/* ---------- fila de atualização (respeita o limite de tempo do Apps Script) ---------- */

function props_() { return PropertiesService.getScriptProperties(); }

function atualizarTudo() {
  var msg = rodarCiclo_(true);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
}

function rodarCiclo_(forcar) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 'Já existe uma atualização em andamento. Aguarde alguns minutos.';
  try {
    var cfg = lerConfig_();
    var baixa = darBaixaPagos();
    atualizarResumoMaster();
    var M = carregarMestre_(cfg);
    props_().setProperty('FILA', JSON.stringify(unidadesAtivas_(M, cfg)));
    var fim = processarFila_(M, cfg);
    return baixa + '\n' + (fim ? 'Todas as planilhas das escolas foram atualizadas.' : 'Atualização em andamento. O script continua sozinho a cada minuto até terminar.');
  } finally { lock.releaseLock(); }
}

function processarFila_(M, cfg) {
  var inicio = Date.now(), fila = JSON.parse(props_().getProperty('FILA') || '[]');
  while (fila.length) {
    if (Date.now() - inicio > LIMITE_MS) {
      props_().setProperty('FILA', JSON.stringify(fila));
      limparGatilhosContinuacao_();
      ScriptApp.newTrigger('continuarFila').timeBased().after(60 * 1000).create();
      return false;
    }
    var u = fila.shift();
    try { sincronizarPlanilhaEscola_(u, M, cfg); }
    catch (e) { registrarErro_('Escola ' + u + ': ' + e.message); }
  }
  props_().setProperty('FILA', '[]');
  limparGatilhosContinuacao_();
  SpreadsheetApp.flush();
  props_().setProperty('ULT_ATUALIZ', String(DriveApp.getFileById(M.ss.getId()).getLastUpdated().getTime()));
  var enviar = props_().getProperty('ENVIAR_APOS');
  if (enviar) { props_().deleteProperty('ENVIAR_APOS'); try { executarPorAba(enviar); } catch (e2) { registrarErro_('Envio ' + enviar + ': ' + e2.message); } }
  return true;
}

function continuarFila() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try { var cfg = lerConfig_(); processarFila_(carregarMestre_(cfg), cfg); } finally { lock.releaseLock(); }
}

function limparGatilhosContinuacao_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'continuarFila') ScriptApp.deleteTrigger(t); });
}

function registrarErro_(txt) {
  var ss = SpreadsheetApp.getActive(), log = ss.getSheetByName(ABA_LOG) || ss.insertSheet(ABA_LOG);
  if (log.getLastRow() === 0) log.appendRow(['Data/hora', 'Aba', 'Unidade', 'Qtd títulos', 'Total', 'Modo', 'Destino', 'Títulos']);
  log.appendRow([new Date(), 'ERRO', txt, '', '', '', '', '']);
}

/* ---------- envio dos cards por e-mail ---------- */

function abrirSeletor() {
  var abas = listarAbasMes_();
  if (!abas.length) { SpreadsheetApp.getUi().alert('Nenhuma aba no formato MM/AAAA encontrada.'); return; }
  var opts = abas.map(function (n, i) { return '<option' + (i === abas.length - 1 ? ' selected' : '') + '>' + n + '</option>'; }).join('');
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;padding:8px"><p><b>Qual aba (mês em aberto)?</b></p>' +
    '<select id="aba" style="width:100%;padding:6px">' + opts + '</select>' +
    '<p style="color:#555;font-size:12px">Modo atual: <b>' + lerConfig_().modo + '</b> (altere em Config, célula B1)</p>' +
    '<button onclick="go()" style="padding:8px 14px;background:#1a237e;color:#fff;border:0;border-radius:6px">Gerar cards</button>' +
    '<p id="st"></p><script>function go(){document.getElementById("st").innerText="Processando...";' +
    'google.script.run.withSuccessHandler(function(m){document.getElementById("st").innerText=m}).withFailureHandler(function(e){document.getElementById("st").innerText="Erro: "+e.message})' +
    '.executarPorAba(document.getElementById("aba").value)}</script></div>').setWidth(340).setHeight(240);
  SpreadsheetApp.getUi().showModalDialog(html, 'Financeiro BRASAS: enviar cards');
}

function linkDaAba_(unidade, mes, M, cfg) {
  var pasta = DriveApp.getFolderById(cfg.pastaId), arq = acharArquivo_(pasta, 'Inadimplência - ' + unidade), gid = null;
  if (arq) { var s = SpreadsheetApp.openById(arq.getId()).getSheetByName(mes); if (s) gid = s.getSheetId(); }
  if (!arq || gid === null) { var r = sincronizarPlanilhaEscola_(unidade, M, cfg); arq = r.arq; gid = r.gids[mes]; }
  return arq.getUrl() + '#gid=' + gid;
}

function executarPorAba(nomeAba) {
  var cfg = lerConfig_(), M = carregarMestre_(cfg), ss = M.ss;
  if (!M.abertos[nomeAba]) throw new Error('Aba "' + nomeAba + '" não encontrada.');
  var grupos = M.abertos[nomeAba], hoje = M.hoje, logo = logoBlob_();
  var log = ss.getSheetByName(ABA_LOG) || ss.insertSheet(ABA_LOG);
  if (log.getLastRow() === 0) log.appendRow(['Data/hora', 'Aba', 'Unidade', 'Qtd títulos', 'Total', 'Modo', 'Destino', 'Títulos']);
  var enviados = 0, semEmail = [];
  Object.keys(grupos).sort().forEach(function (u) {
    var e = cfg.escolas[u] || { nome: 'BRASAS ' + u, email: '', ativo: true };
    if (!e.ativo) return;
    var ctx = { escola: e.nome, unidade: u, aba: nomeAba, hoje: hoje, itens: grupos[u], logoSrc: 'cid:logoBrasas', link: linkDaAba_(u, nomeAba, M, cfg) };
    var html = renderCard_(ctx), assunto = assuntoCard_(ctx), s = resumir_(ctx.itens);
    var para = cfg.destino, opts = { htmlBody: html, name: 'Financeiro BRASAS', inlineImages: { logoBrasas: logo } };
    if (cfg.modo === 'PRODUCAO') {
      if (!e.email) { semEmail.push(u); return; }
      para = String(e.email).split(/[;,\s]+/).filter(String).join(','); opts.cc = cfg.destino;
    }
    if (cfg.modo === 'RASCUNHO') GmailApp.createDraft(para, assunto, 'Visualize este e-mail em HTML.', opts);
    else GmailApp.sendEmail(para, assunto, 'Visualize este e-mail em HTML.', opts);
    log.appendRow([hoje, nomeAba, u, s.qtd, s.total, cfg.modo, para, ctx.itens.map(function (t) { return t.titulo; }).join(', ')]);
    enviados++;
  });
  var msg = enviados + ' card(s) ' + (cfg.modo === 'RASCUNHO' ? 'salvos como rascunho' : 'enviados') + ' (modo ' + cfg.modo + ').';
  if (semEmail.length) msg += ' Sem e-mail de gerente cadastrado: ' + semEmail.join(', ') + '.';
  return msg;
}

/* ---------- rotinas automáticas ---------- */

/** A cada hora: só atualiza se a planilha mudou desde a última atualização. */
function rotinaHoraria() {
  if ((props_().getProperty('FILA') || '[]') !== '[]') return;   // atualização anterior ainda em andamento
  var ult = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getLastUpdated().getTime();
  if (String(ult) === props_().getProperty('ULT_ATUALIZ')) return;
  rodarCiclo_(false);
}

/** Todo dia às 08h: nos dias definidos em Config, atualiza tudo e depois envia os cards do mês mais recente. */
function rotinaDiaria() {
  var cfg = lerConfig_();
  if (cfg.dias.indexOf(new Date().getDate()) < 0) return;
  var abas = listarAbasMes_();
  if (!abas.length) return;
  props_().setProperty('ENVIAR_APOS', abas[abas.length - 1]);
  rodarCiclo_(true);
}

function removerGatilho() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['rotinaDiaria', 'rotinaHoraria', 'continuarFila'].indexOf(t.getHandlerFunction()) > -1) ScriptApp.deleteTrigger(t);
  });
  try { SpreadsheetApp.getUi().alert('Rotina automática desligada.'); } catch (e) {}
}

function instalarGatilho() {
  removerGatilho_();
  ScriptApp.newTrigger('rotinaHoraria').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('rotinaDiaria').timeBased().everyDays(1).atHour(8).create();
  SpreadsheetApp.getUi().alert('Rotina automática ligada.\n\nA cada hora: se a planilha mudou, atualiza pagos, resumos e as planilhas das escolas.\nÀs 08h nos dias definidos em Config (B3): atualiza tudo e envia os cards do mês mais recente.');
}
function removerGatilho_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['rotinaDiaria', 'rotinaHoraria', 'continuarFila'].indexOf(t.getHandlerFunction()) > -1) ScriptApp.deleteTrigger(t);
  });
}
