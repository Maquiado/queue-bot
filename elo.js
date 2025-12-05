const ELO_BASE = {
  Ferro: 100,
  Bronze: 200,
  Prata: 300,
  Ouro: 500,
  Platina: 800,
  Esmeralda: 1100,
  Diamante: 1500,
  Mestre: 2100,
  'Grão-Mestre': 2300,
  Desafiante: 2500
};

function sortTeams(jogadores) {
  const ordenados = [...jogadores].sort((a, b) => (ELO_BASE[b.elo] || 0) - (ELO_BASE[a.elo] || 0));
  const t1 = [];
  const t2 = [];
  ordenados.forEach((p, i) => (i % 2 === 0 ? t1 : t2).push(p));
  return { time1: { jogadores: t1 }, time2: { jogadores: t2 } };
}

module.exports = { ELO_BASE, sortTeams };

