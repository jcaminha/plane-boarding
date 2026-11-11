/*
 * Motor de simulação de embarque.
 * Sem dependências de DOM: roda no navegador (window.BoardingSim) e no Node (require).
 *
 * Modelo: o corredor é uma fila única e contínua (ninguém ultrapassa ninguém).
 * A fileira r fica na posição x = r; a porta fica em x = 0 e a ponte de embarque
 * ocupa x < 0. Cada passageiro anda até a sua fileira, guarda a bagagem
 * (bloqueando o corredor), espera os vizinhos já sentados se levantarem se
 * precisar passar por eles, e senta.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardingSim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var JET = 6; // comprimento da ponte de embarque, em fileiras
  var LETTERS = 'ABCDEFGH';
  var ST = { QUEUE: 0, WALK: 1, STOW: 2, SIT: 3, SEATED: 4 };

  /* ---------- aleatoriedade reprodutível ---------- */

  function rng32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function uniform(rng, a, b) {
    return a + rng() * (b - a);
  }

  /* ---------- geração de passageiros ---------- */

  /**
   * cfg: { rows, perSide, occupancy (0..1), familyShare (0..1), bagRate (0..1) }
   * Devolve uma lista de passageiros com assento marcado. Famílias e casais
   * recebem assentos vizinhos e compartilham o mesmo `group`.
   */
  function generatePassengers(cfg, seed) {
    var rng = rng32(seed);
    var R = cfg.rows;
    var S = cfg.perSide;
    var W = 2 * S;
    var target = Math.max(1, Math.round(R * W * cfg.occupancy));
    var free = [];
    for (var r = 0; r <= R; r++) free.push(new Array(W).fill(true));

    // 1. composição dos grupos
    var groups = [];
    var n = 0;
    var famTarget = Math.round(target * cfg.familyShare);
    while (n < famTarget && target - n >= 2) {
      var u = rng();
      var size = u < 0.25 ? 2 : u < 0.65 ? 3 : u < 0.9 ? 4 : 5;
      size = Math.min(size, W, target - n);
      var adults = size === 2 ? 1 : size === 3 ? (rng() < 0.7 ? 2 : 1) : 2;
      var kinds = [];
      for (var k = 0; k < size - adults; k++) kinds.push('child');
      for (k = 0; k < adults; k++) kinds.push('adult');
      groups.push({ family: true, kinds: kinds });
      n += size;
    }
    var couples = Math.floor(((target - n) * 0.2) / 2);
    for (var c = 0; c < couples; c++) {
      var kind = rng() < 0.15 ? 'senior' : 'adult';
      groups.push({ family: false, kinds: [kind, kind] });
      n += 2;
    }
    while (n < target) {
      groups.push({ family: false, kinds: [rng() < 0.12 ? 'senior' : 'adult'] });
      n++;
    }

    // 2. assentos: procura um bloco de assentos vizinhos numa fileira sorteada
    function isFree(row, cols) {
      for (var i = 0; i < cols.length; i++) if (!free[row][cols[i]]) return false;
      return true;
    }
    function range(from, count) {
      var a = [];
      for (var i = 0; i < count; i++) a.push(from + i);
      return a;
    }
    function findBlock(size) {
      var rows = shuffle(range(1, R), rng);
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var sides = rng() < 0.5 ? [0, 1] : [1, 0];
        for (var s = 0; s < 2; s++) {
          var side = sides[s];
          if (size <= S) {
            var options = [];
            for (var o = 0; o + size <= S; o++) {
              var cols = range(side * S + o, size);
              if (isFree(row, cols)) options.push(cols);
            }
            if (options.length) {
              return { row: row, cols: options[Math.floor(rng() * options.length)] };
            }
          } else {
            // um lado inteiro + assentos do outro lado, a partir do corredor
            var extra = size - S;
            var full = range(side * S, S);
            var other = side === 0 ? range(S, extra) : range(S - extra, extra);
            var all = full.concat(other);
            if (isFree(row, all)) return { row: row, cols: all };
          }
        }
      }
      return null;
    }

    var passengers = [];
    function fromWindowOf(col) {
      return col < S ? col : W - 1 - col;
    }
    function place(kinds, gid, family, gsize) {
      var block = findBlock(kinds.length);
      if (!block) {
        // avião cheio demais para manter todos juntos: divide o grupo
        var half = Math.ceil(kinds.length / 2);
        place(kinds.slice(0, half), gid, family, gsize);
        place(kinds.slice(half), gid, family, gsize);
        return;
      }
      // crianças (primeiras da lista) ficam com os assentos mais perto da janela
      var cols = block.cols.slice().sort(function (a, b) {
        return fromWindowOf(a) - fromWindowOf(b);
      });
      for (var i = 0; i < kinds.length; i++) {
        var col = cols[i];
        free[block.row][col] = false;
        passengers.push(makePassenger(kinds[i], block.row, col, gid, family, gsize));
      }
    }

    function makePassenger(kind, row, col, gid, family, gsize) {
      var bags = 0;
      var speed, stowFactor, sitFactor, size;
      if (kind === 'child') {
        // criança leva só mochila, que vai embaixo do assento
        speed = uniform(rng, 0.6, 0.9);
        stowFactor = 1;
        sitFactor = 1.3;
        size = 0.55;
      } else if (kind === 'senior') {
        if (rng() < cfg.bagRate) bags = 1;
        speed = uniform(rng, 0.5, 0.75);
        stowFactor = 1.5;
        sitFactor = 1.4;
        size = 0.8;
      } else {
        // adulto de família carrega também as coisas das crianças
        var p1 = family ? Math.min(1, cfg.bagRate * 1.15) : cfg.bagRate;
        var p2 = family ? 0.45 : 0.25;
        if (rng() < p1) bags = rng() < p2 ? 2 : 1;
        speed = uniform(rng, 0.95, 1.35);
        stowFactor = 1;
        sitFactor = 1;
        size = 0.8;
      }
      speed *= 1 - 0.08 * bags;
      var fw = fromWindowOf(col);
      return {
        id: passengers.length,
        group: gid,
        groupSize: gsize,
        family: family,
        kind: kind,
        row: row,
        col: col,
        side: col < S ? 0 : 1,
        fromWindow: fw,
        isWindow: fw === 0,
        isAisle: fw === S - 1,
        isMiddle: fw > 0 && fw < S - 1,
        seat: row + LETTERS[col],
        bags: bags,
        speed: speed,
        stowFactor: stowFactor,
        sitFactor: sitFactor,
        size: size,
      };
    }

    // grupos maiores primeiro, para caberem juntos
    groups
      .map(function (g, i) {
        return { g: g, i: i };
      })
      .sort(function (a, b) {
        return b.g.kinds.length - a.g.kinds.length || a.i - b.i;
      })
      .forEach(function (e, gid) {
        place(e.g.kinds, gid, e.g.family, e.g.kinds.length);
      });

    return passengers;
  }

  function summarize(passengers) {
    var s = { total: passengers.length, families: 0, children: 0, seniors: 0, bags: 0, solo: 0 };
    var fam = {};
    passengers.forEach(function (p) {
      if (p.family) fam[p.group] = 1;
      if (p.kind === 'child') s.children++;
      if (p.kind === 'senior') s.seniors++;
      if (p.groupSize === 1) s.solo++;
      s.bags += p.bags;
    });
    s.families = Object.keys(fam).length;
    return s;
  }

  /* ---------- estratégias ---------- */
  // key(p, ctx) devolve um número: quem tem o menor valor embarca primeiro.
  // Empates são desfeitos por sorteio.

  function zoneSize(ctx) {
    return Math.ceil(ctx.rows / 5);
  }

  var STRATEGIES = [
    {
      id: 'random',
      name: 'Aleatório',
      desc: 'Todos embarcam em ordem de chegada, sem nenhuma organização.',
      key: function () {
        return 0;
      },
    },
    {
      id: 'backfront',
      name: 'Trás para frente',
      desc: 'Cinco zonas de fileiras, do fundo para a frente. É o método mais usado pelas companhias.',
      key: function (p, ctx) {
        return Math.floor((ctx.rows - p.row) / zoneSize(ctx));
      },
    },
    {
      id: 'frontback',
      name: 'Frente para trás',
      desc: 'Cinco zonas de fileiras, da frente para o fundo. Serve de referência do pior caso.',
      key: function (p, ctx) {
        return Math.floor((p.row - 1) / zoneSize(ctx));
      },
    },
    {
      id: 'rotating',
      name: 'Zonas alternadas',
      desc: 'Zona do fundo, depois a da frente, depois a segunda do fundo, e assim por diante.',
      key: function (p, ctx) {
        var zs = zoneSize(ctx);
        var nz = Math.ceil(ctx.rows / zs);
        var zb = Math.floor((ctx.rows - p.row) / zs);
        return zb < nz / 2 ? 2 * zb : 2 * (nz - 1 - zb) + 1;
      },
    },
    {
      id: 'wma',
      name: 'Janela, meio, corredor',
      desc: 'Primeiro todas as janelas, depois os assentos do meio e por fim os do corredor.',
      key: function (p) {
        return p.fromWindow;
      },
    },
    {
      id: 'pyramid',
      name: 'Pirâmide invertida',
      desc: 'Combina janela-primeiro com fundo-primeiro: janelas do fundo, depois janelas da frente junto com meios do fundo, etc.',
      key: function (p, ctx) {
        var third = Math.min(2, Math.floor(((p.row - 1) / ctx.rows) * 3));
        return p.fromWindow * 2 + (2 - third);
      },
    },
    {
      id: 'steffen',
      name: 'Steffen',
      desc: 'Ordem exata: janelas de um lado em fileiras alternadas, do fundo para a frente; depois o outro lado; depois meios e corredores.',
      key: function (p, ctx) {
        var parity = (ctx.rows - p.row) % 2;
        return ((p.fromWindow * 2 + parity) * 2 + p.side) * (ctx.rows + 1) + (ctx.rows - p.row);
      },
    },
    {
      id: 'steffenmod',
      name: 'Steffen modificado',
      desc: 'Quatro grupos: fileiras pares de um lado, pares do outro, ímpares de um lado, ímpares do outro. Mantém vizinhos de assento juntos.',
      key: function (p, ctx) {
        return ((ctx.rows - p.row) % 2) * 2 + p.side;
      },
    },
  ];

  /**
   * Monta a fila de embarque.
   * opts.keepGroups: famílias e casais embarcam juntos (na vez do primeiro chamado).
   * opts.preboard:   grupos com crianças embarcam antes de todos.
   */
  function buildOrder(passengers, strategy, cfg, opts, seed) {
    var rng = rng32(seed);
    var ctx = { rows: cfg.rows, perSide: cfg.perSide, total: passengers.length, random: rng };
    var tie = passengers.map(function () {
      return rng();
    });
    var hasChild = {};
    passengers.forEach(function (p) {
      if (p.kind === 'child') hasChild[p.group] = true;
    });

    var units = [];
    var byGroup = {};
    passengers.forEach(function (p, i) {
      var k = Number(strategy.key(p, ctx));
      if (k !== k) k = Infinity; // NaN vai para o fim
      var pre = opts.preboard && hasChild[p.group] ? 0 : 1;
      if (opts.keepGroups && p.groupSize > 1) {
        var unit = byGroup[p.group];
        if (!unit) {
          unit = byGroup[p.group] = { members: [], k: k, r: tie[i], pre: pre };
          units.push(unit);
        } else if (k < unit.k) {
          unit.k = k;
        }
        unit.members.push(p);
      } else {
        units.push({ members: [p], k: k, r: tie[i], pre: pre });
      }
    });

    units.sort(function (a, b) {
      return a.pre - b.pre || a.k - b.k || a.r - b.r;
    });

    var order = [];
    units.forEach(function (unit) {
      // dentro do grupo: fileira do fundo primeiro, janela primeiro
      unit.members.sort(function (a, b) {
        return b.row - a.row || a.fromWindow - b.fromWindow;
      });
      for (var i = 0; i < unit.members.length; i++) order.push(unit.members[i]);
    });
    return order;
  }

  /* ---------- simulação ---------- */

  function Simulation(cfg, order, seed) {
    this.cfg = cfg;
    this.R = cfg.rows;
    this.S = cfg.perSide;
    this.W = 2 * cfg.perSide;
    this.rng = rng32(seed);
    this.binCap = cfg.binCap || cfg.perSide; // malas por lado, por fileira
    this.agents = order.map(function (p, i) {
      return { p: p, i: i, x: -JET, state: ST.QUEUE, timer: 0, dur: 0, wait: 0, tIn: 0, tSeat: 0, blockers: null };
    });
    this.next = 0;
    this.aisle = []; // quem está no corredor; o mais adiantado primeiro
    this.seated = 0;
    this.t = 0;
    this.occ = new Uint8Array((this.R + 1) * this.W);
    this.bins = new Uint8Array((this.R + 1) * 2);
    this.stats = { interferences: 0, overflow: 0, wait: 0, travel: 0 };
    this.done = this.agents.length === 0;
  }

  Simulation.prototype._stowTime = function (p) {
    var t = 0;
    var cap = this.binCap;
    for (var b = 0; b < p.bags; b++) {
      var idx = p.row * 2 + p.side;
      if (this.bins[idx] < cap) {
        t += 5 + 6 * (this.bins[idx] / cap); // bagageiro mais cheio = mais demorado
        this.bins[idx]++;
        continue;
      }
      // bagageiro da fileira lotado: procura o espaço livre mais próximo
      this.stats.overflow++;
      var found = false;
      for (var d = 0; d <= this.R && !found; d++) {
        var cand = d === 0 ? [[p.row, 1 - p.side]] : [[p.row - d, p.side], [p.row + d, p.side], [p.row - d, 1 - p.side], [p.row + d, 1 - p.side]];
        for (var c = 0; c < cand.length; c++) {
          var row = cand[c][0];
          if (row < 1 || row > this.R) continue;
          var j = row * 2 + cand[c][1];
          if (this.bins[j] < cap) {
            this.bins[j]++;
            t += 7 + 3 * d;
            found = true;
            break;
          }
        }
      }
      if (!found) t += 15; // não coube em lugar nenhum: mala despachada na porta
    }
    return t * p.stowFactor * uniform(this.rng, 0.8, 1.3);
  };

  Simulation.prototype._beginSit = function (a) {
    var p = a.p;
    var blockers = [];
    for (var fw = p.fromWindow + 1; fw < this.S; fw++) {
      var col = p.side === 0 ? fw : this.W - 1 - fw;
      if (this.occ[p.row * this.W + col]) blockers.push(col);
    }
    var extra = blockers.length === 0 ? 0 : blockers.length === 1 ? 5 : 9;
    if (blockers.length) this.stats.interferences++;
    a.blockers = blockers;
    a.state = ST.SIT;
    a.dur = a.timer = (2 + extra) * p.sitFactor * uniform(this.rng, 0.85, 1.2);
  };

  Simulation.prototype.step = function (dt) {
    if (this.done) return;
    this.t += dt;
    var aisle = this.aisle;
    var left = false;

    for (var i = 0; i < aisle.length; i++) {
      var a = aisle[i];
      if (a.state === ST.WALK) {
        var target = a.p.row;
        var limit = target;
        if (i > 0) {
          var ahead = aisle[i - 1];
          // quem está guardando mala precisa de mais espaço no corredor
          var gap = ahead.state === ST.STOW ? 1.2 : (a.p.size + ahead.p.size) / 2;
          if (ahead.x - gap < limit) limit = ahead.x - gap;
        }
        var nx = a.x + a.p.speed * dt;
        if (nx > limit) nx = limit;
        if (nx > a.x + 1e-9) a.x = nx;
        else if (a.x < target - 1e-6) a.wait += dt;
        if (a.x >= target - 1e-6) {
          a.x = target;
          if (a.p.bags > 0) {
            a.state = ST.STOW;
            a.dur = a.timer = this._stowTime(a.p);
          } else {
            this._beginSit(a);
          }
        }
      } else if (a.state === ST.STOW) {
        a.timer -= dt;
        if (a.timer <= 0) this._beginSit(a);
      } else if (a.state === ST.SIT) {
        a.timer -= dt;
        if (a.timer <= 0) {
          a.state = ST.SEATED;
          a.tSeat = this.t;
          this.occ[a.p.row * this.W + a.p.col] = 1;
          this.seated++;
          this.stats.wait += a.wait;
          this.stats.travel += a.tSeat - a.tIn;
          left = true;
        }
      }
    }
    if (left) {
      this.aisle = aisle = aisle.filter(function (a) {
        return a.state !== ST.SEATED;
      });
    }

    // a ponte de embarque está sempre cheia: entra o próximo assim que houver espaço
    if (this.next < this.agents.length) {
      var last = aisle[aisle.length - 1];
      var nextA = this.agents[this.next];
      if (!last || last.x >= -JET + (last.p.size + nextA.p.size) / 2) {
        nextA.state = ST.WALK;
        nextA.x = -JET;
        nextA.tIn = this.t;
        aisle.push(nextA);
        this.next++;
      }
    }
    if (this.seated === this.agents.length) this.done = true;
  };

  Simulation.prototype.result = function () {
    var n = Math.max(1, this.seated);
    return {
      time: this.t,
      meanTravel: this.stats.travel / n,
      meanWait: this.stats.wait / n,
      interferences: this.stats.interferences,
      overflow: this.stats.overflow,
    };
  };

  Simulation.prototype.run = function (dt) {
    dt = dt || 0.2;
    var guard = 0;
    while (!this.done && guard++ < 500000) this.step(dt);
    return this.result();
  };

  return {
    JET: JET,
    ST: ST,
    LETTERS: LETTERS,
    STRATEGIES: STRATEGIES,
    rng32: rng32,
    generatePassengers: generatePassengers,
    summarize: summarize,
    buildOrder: buildOrder,
    Simulation: Simulation,
  };
});
