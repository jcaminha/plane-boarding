/* Interface: pistas animadas, editor de estratégias e comparação estatística. */
(function () {
  'use strict';

  var S = window.BoardingSim;
  var ST = S.ST;
  var JET = S.JET;
  var DT = 0.1; // passo da simulação animada, em segundos simulados
  var AISLE = 1.25; // largura do corredor no desenho, em células
  var STORE_KEY = 'plane-boarding.custom.v1';
  var ZONES = 8;

  var $ = function (sel, el) {
    return (el || document).querySelector(sel);
  };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var state = {
    cfg: { rows: 30, perSide: 3, occupancy: 0.9, familyShare: 0.3, bagRate: 0.8 },
    seed: 2026,
    keepGroups: true,
    preboard: false,
    speed: 10,
    colorMode: 'kind',
    playing: false,
    selected: ['backfront', 'random', 'steffen'],
    customs: loadCustoms(),
    passengers: [],
    lanes: [],
    finished: 0,
  };

  /* ---------- estratégias personalizadas ---------- */

  function loadCustoms() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }
  function saveCustoms() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.customs));
    } catch (e) {
      /* sem armazenamento: as estratégias valem só nesta sessão */
    }
  }

  function zoneOf(grid, p, ctx) {
    var zr = grid.length;
    var zc = grid[0].length;
    var zs = zc / 2;
    var ri = ctx.rows <= 1 ? 0 : Math.round(((p.row - 1) / (ctx.rows - 1)) * (zr - 1));
    var fw = ctx.perSide <= 1 ? 0 : Math.round((p.fromWindow / (ctx.perSide - 1)) * (zs - 1));
    return grid[ri][p.side === 0 ? fw : zc - 1 - fw];
  }

  function compileCustom(c) {
    var st = { id: c.id, name: c.name, custom: true, source: c };
    if (c.type === 'code') {
      st.desc = 'Estratégia personalizada (fórmula).';
      try {
        st.key = new Function('p', 'ctx', c.code);
      } catch (e) {
        st.error = e.message;
        st.key = function () {
          return 0;
        };
      }
    } else {
      var within = { random: 'ordem aleatória', back: 'do fundo para a frente', front: 'da frente para o fundo' }[c.within];
      st.desc = 'Estratégia personalizada (grupos pintados; ' + within + ' dentro de cada grupo).';
      st.key = function (p, ctx) {
        var z = zoneOf(c.grid, p, ctx);
        return z * 1000 + (c.within === 'back' ? ctx.rows - p.row : c.within === 'front' ? p.row : 0);
      };
    }
    return st;
  }

  function allStrategies() {
    return S.STRATEGIES.concat(state.customs.map(compileCustom));
  }

  /* ---------- cores ---------- */

  var C = {};
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    ['cabin', 'bridge', 'seat', 'stow', 'line', 'ink', 'ink-3', 'surface', 'p-adult', 'p-group', 'p-child', 'p-senior'].forEach(function (k) {
      C[k] = cs.getPropertyValue('--' + k).trim();
    });
  }
  var RAMP = [
    [255, 200, 60],
    [240, 96, 60],
    [190, 50, 150],
    [70, 90, 225],
  ];
  function rampColor(t) {
    var f = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    var i = Math.min(RAMP.length - 2, Math.floor(f));
    var k = f - i;
    var a = RAMP[i];
    var b = RAMP[i + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * k) + ',' + Math.round(a[1] + (b[1] - a[1]) * k) + ',' + Math.round(a[2] + (b[2] - a[2]) * k) + ')';
  }
  function kindColor(p) {
    if (p.kind === 'child') return C['p-child'];
    if (p.kind === 'senior') return C['p-senior'];
    return p.groupSize > 1 ? C['p-group'] : C['p-adult'];
  }

  /* ---------- cenário e pistas ---------- */

  function fmt(t) {
    var s = Math.round(t);
    var m = Math.floor(s / 60);
    s -= m * 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function regenerate() {
    state.passengers = S.generatePassengers(state.cfg, state.seed);
    var s = S.summarize(state.passengers);
    $('#paxSummary').textContent =
      s.total + ' passageiros: ' + s.families + ' famílias, ' + s.children + ' crianças, ' + s.seniors + ' idosos, ' + s.solo + ' sozinhos. ' + s.bags + ' malas de mão.';
    resetSims();
  }

  function buildLanes() {
    var stage = $('#stage');
    stage.textContent = '';
    state.lanes = [];
    allStrategies().forEach(function (st) {
      if (state.selected.indexOf(st.id) < 0) return;
      var art = el('article', 'lane');
      var head = el('div', 'lane-head');
      var rank = el('span', 'rank');
      var metrics = el('div', 'metrics');
      metrics.innerHTML = '<span>sentados <b class="m-seat"></b></span><span>trocas de assento <b class="m-int"></b></span><span class="timer"><b class="m-time"></b></span>';
      head.append(rank, el('h3', null, st.name), el('span', 'lane-desc', st.desc), metrics);
      var prog = el('div', 'progress');
      var bar = el('i');
      prog.append(bar);
      var canvas = el('canvas');
      var err = el('p', 'error');
      err.hidden = true;
      art.append(head, prog, canvas, err);
      stage.append(art);
      var lane = {
        st: st,
        art: art,
        canvas: canvas,
        rank: rank,
        bar: bar,
        err: err,
        mSeat: $('.m-seat', art),
        mInt: $('.m-int', art),
        mTime: $('.m-time', art),
        sim: null,
        seatMap: null,
        u: 20,
        place: 0,
      };
      attachHover(lane);
      state.lanes.push(lane);
    });
    if (!state.lanes.length) {
      stage.append(el('p', 'empty', 'Marque ao menos uma estratégia na lista ao lado para ver a animação.'));
    }
    layoutLanes();
  }

  function resetSims() {
    state.playing = false;
    state.finished = 0;
    acc = 0;
    var opts = { keepGroups: state.keepGroups, preboard: state.preboard };
    state.lanes.forEach(function (l) {
      l.place = 0;
      l.rank.textContent = '';
      l.art.classList.remove('winner');
      l.err.hidden = true;
      l.canvas.hidden = false;
      try {
        if (l.st.error) throw new Error(l.st.error);
        var order = S.buildOrder(state.passengers, l.st, state.cfg, opts, state.seed * 31 + 17);
        l.sim = new S.Simulation(state.cfg, order, state.seed + 99);
        l.seatMap = {};
        l.sim.agents.forEach(function (a) {
          l.seatMap[a.p.row * 16 + a.p.col] = a;
        });
      } catch (e) {
        l.sim = null;
        l.canvas.hidden = true;
        l.err.hidden = false;
        l.err.textContent = 'Erro na estratégia: ' + e.message;
      }
    });
    updateUI();
    drawAll();
  }

  function layoutLanes() {
    var dpr = window.devicePixelRatio || 1;
    var R = state.cfg.rows;
    var W = state.cfg.perSide * 2;
    state.lanes.forEach(function (l) {
      var w = l.art.clientWidth - 28;
      if (w <= 0) return;
      var u = Math.min(30, w / (JET + R + 2));
      var h = (W + AISLE + 1.7) * u;
      l.u = u;
      l.w = w;
      l.h = h;
      l.canvas.style.height = h + 'px';
      l.canvas.width = Math.round(w * dpr);
      l.canvas.height = Math.round(h * dpr);
    });
    drawAll();
  }

  /* ---------- desenho ---------- */

  function geom(l) {
    var u = l.u;
    var Sd = state.cfg.perSide;
    var top = 1.15 * u;
    return {
      u: u,
      X: function (x) {
        return (x + JET + 0.6) * u;
      },
      seatY: function (col) {
        return top + (col < Sd ? col + 0.5 : col + 0.5 + AISLE) * u;
      },
      aisleY: top + (Sd + AISLE / 2) * u,
      top: top,
    };
  }

  function rr(g, x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r);
    else g.rect(x, y, w, h);
  }

  function draw(l) {
    var sim = l.sim;
    if (!sim || !l.w) return;
    var g = l.canvas.getContext('2d');
    var dpr = l.canvas.width / l.w;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, l.w, l.h);

    var G = geom(l);
    var u = G.u;
    var R = sim.R;
    var Sd = sim.S;
    var W = sim.W;
    var n = sim.agents.length;
    var byOrder = state.colorMode === 'order';
    var color = function (a) {
      return byOrder ? rampColor(n > 1 ? a.i / (n - 1) : 0) : kindColor(a.p);
    };

    // ponte de embarque
    g.fillStyle = C.bridge;
    rr(g, G.X(-JET) - 0.5 * u, G.aisleY - 0.55 * u, G.X(0.5) - G.X(-JET) + 0.5 * u, 1.1 * u, 0.2 * u);
    g.fill();

    // fuselagem
    var bx = G.X(0.42);
    var by = G.top - 0.3 * u;
    rr(g, bx, by, G.X(R + 0.75) - bx, (W + AISLE) * u + 0.6 * u, [0.9 * u, 1.6 * u, 1.6 * u, 0.9 * u]);
    g.fillStyle = C.cabin;
    g.fill();
    g.strokeStyle = C.line;
    g.lineWidth = 1.5;
    g.stroke();
    // a porta: abertura na parede da frente
    g.fillStyle = C.bridge;
    g.fillRect(bx - 1.5, G.aisleY - 0.5 * u, 3, u);

    // números das fileiras
    g.fillStyle = C['ink-3'];
    g.font = Math.max(8, Math.min(11, u * 0.42)) + 'px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (var r = 1; r <= R; r++) {
      if (r === 1 || r % 5 === 0) g.fillText(r, G.X(r), G.top - 0.72 * u);
    }
    if (sim.next < n) {
      g.textAlign = 'left';
      g.fillText('fila: ' + (n - sim.next), G.X(-JET) - 0.3 * u, G.aisleY - 1.1 * u);
    }

    // assentos
    var s = 0.8 * u;
    g.lineWidth = 1;
    g.strokeStyle = C.seat;
    for (r = 1; r <= R; r++) {
      for (var c = 0; c < W; c++) {
        rr(g, G.X(r) - s / 2, G.seatY(c) - s / 2, s, s, 0.2 * u);
        g.stroke();
      }
    }

    // passageiros sentados e assentos reservados
    var agents = sim.agents;
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      var p = a.p;
      var rad = (p.kind === 'child' ? 0.23 : 0.32) * u;
      if (a.state === ST.SEATED) {
        g.fillStyle = color(a);
        g.beginPath();
        g.arc(G.X(p.row), G.seatY(p.col), rad, 0, 6.2832);
        g.fill();
      } else {
        // ainda não sentou: marca discreta de quem vai ocupar o assento
        g.globalAlpha = 0.28;
        g.fillStyle = color(a);
        rr(g, G.X(p.row) - s / 2, G.seatY(p.col) - s / 2, s, s, 0.2 * u);
        g.fill();
        g.globalAlpha = 1;
      }
    }

    // quem está no corredor
    var aisle = sim.aisle;
    for (i = 0; i < aisle.length; i++) {
      a = aisle[i];
      p = a.p;
      rad = (p.kind === 'child' ? 0.23 : 0.32) * u;
      var x = G.X(a.x);
      var y = G.aisleY;
      var dir = p.side === 0 ? -1 : 1;
      if (a.state === ST.SIT) {
        var k = 1 - a.timer / a.dur;
        // primeiro espera os vizinhos levantarem, depois entra
        var wait = a.blockers.length ? 0.45 : 0;
        var kk = k <= wait ? 0 : (k - wait) / (1 - wait);
        y += (G.seatY(p.col) - y) * kk;
        g.strokeStyle = C.stow;
        g.lineWidth = 2;
        for (var b = 0; b < a.blockers.length; b++) {
          rr(g, G.X(p.row) - s / 2, G.seatY(a.blockers[b]) - s / 2, s, s, 0.2 * u);
          g.stroke();
        }
      }
      g.fillStyle = color(a);
      g.beginPath();
      g.arc(x, y, rad, 0, 6.2832);
      g.fill();
      g.strokeStyle = C.cabin;
      g.lineWidth = 1;
      g.stroke();

      if (a.state === ST.STOW) {
        g.strokeStyle = C.stow;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, rad + 2.5, 0, 6.2832);
        g.stroke();
      }
      if (p.bags > 0 && a.state !== ST.SIT) {
        var bs = 0.26 * u;
        var lift = a.state === ST.STOW ? (1 - a.timer / a.dur) * 0.35 * u * dir : 0;
        g.fillStyle = C.ink;
        for (b = 0; b < p.bags; b++) {
          rr(g, x + 0.14 * u + b * bs * 0.7, y + dir * 0.38 * u - bs / 2 + lift, bs, bs, 2);
          g.fill();
        }
      }
    }
  }

  function drawAll() {
    state.lanes.forEach(draw);
  }

  function attachHover(l) {
    var tip = $('#tip');
    l.canvas.addEventListener('mousemove', function (ev) {
      if (!l.sim) return;
      var rect = l.canvas.getBoundingClientRect();
      var G = geom(l);
      var mx = ev.clientX - rect.left;
      var my = ev.clientY - rect.top;
      var row = Math.round(mx / G.u - JET - 0.6);
      var found = null;
      for (var c = 0; c < l.sim.W; c++) {
        if (Math.abs(my - G.seatY(c)) < G.u / 2) found = l.seatMap[row * 16 + c];
      }
      if (!found) {
        tip.hidden = true;
        return;
      }
      var p = found.p;
      var who = { adult: 'adulto', child: 'criança', senior: 'idoso' }[p.kind];
      var grp = p.groupSize === 1 ? 'sozinho' : p.family ? 'família de ' + p.groupSize : 'casal';
      var bags = p.bags === 0 ? 'sem mala' : p.bags === 1 ? '1 mala' : p.bags + ' malas';
      tip.textContent = p.seat + ' · ' + who + ', ' + grp + ', ' + bags + ' · ' + (found.i + 1) + 'º da fila';
      tip.hidden = false;
      tip.style.left = Math.min(window.innerWidth - 270, ev.clientX + 12) + 'px';
      tip.style.top = ev.clientY + 14 + 'px';
    });
    l.canvas.addEventListener('mouseleave', function () {
      tip.hidden = true;
    });
  }

  /* ---------- laço de animação ---------- */

  var acc = 0;
  var lastTs = 0;

  function frame(ts) {
    var real = Math.min(0.1, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    if (state.playing) {
      acc += real * state.speed;
      var steps = Math.min(600, Math.floor(acc / DT));
      acc -= steps * DT;
      var running = 0;
      state.lanes.forEach(function (l) {
        if (!l.sim) return;
        for (var i = 0; i < steps && !l.sim.done; i++) l.sim.step(DT);
        if (l.sim.done && !l.place) l.place = -1; // terminou neste quadro
        if (!l.sim.done) running++;
      });
      rankFinished();
      if (!running) state.playing = false;
      updateUI();
      drawAll();
    }
    requestAnimationFrame(frame);
  }

  function rankFinished() {
    var fresh = state.lanes.filter(function (l) {
      return l.place === -1;
    });
    if (!fresh.length) return;
    fresh.sort(function (a, b) {
      return a.sim.t - b.sim.t;
    });
    fresh.forEach(function (l) {
      l.place = ++state.finished;
      l.rank.textContent = l.place + 'º';
      if (l.place === 1 && state.lanes.length > 1) l.art.classList.add('winner');
    });
  }

  function updateUI() {
    var any = false;
    var allDone = true;
    state.lanes.forEach(function (l) {
      if (!l.sim) return;
      any = true;
      if (!l.sim.done) allDone = false;
      var n = l.sim.agents.length;
      l.mSeat.textContent = l.sim.seated + '/' + n;
      l.mInt.textContent = l.sim.stats.interferences;
      l.mTime.textContent = fmt(l.sim.t);
      l.bar.style.width = (n ? (l.sim.seated / n) * 100 : 0) + '%';
    });
    var play = $('#play');
    play.disabled = !any;
    play.textContent = state.playing ? 'Pausar' : any && allDone ? 'De novo' : acc > 0 || anyStarted() ? 'Continuar' : 'Iniciar';
  }
  function anyStarted() {
    return state.lanes.some(function (l) {
      return l.sim && l.sim.t > 0;
    });
  }

  /* ---------- controles ---------- */

  function setSeg(id, value) {
    document.querySelectorAll('#' + id + ' button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.v === String(value)));
    });
  }
  function onSeg(id, fn) {
    $('#' + id).addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      setSeg(id, b.dataset.v);
      fn(b.dataset.v);
    });
  }

  function renderLegend() {
    var lg = $('#legend');
    lg.textContent = '';
    function item(html, text) {
      var it = el('span', 'item');
      it.innerHTML = html;
      it.append(document.createTextNode(text));
      lg.append(it);
    }
    if (state.colorMode === 'kind') {
      item('<i class="dot" style="background:var(--p-adult)"></i>', 'adulto sozinho');
      item('<i class="dot" style="background:var(--p-group)"></i>', 'adulto em família ou casal');
      item('<i class="dot small" style="background:var(--p-child)"></i>', 'criança');
      item('<i class="dot" style="background:var(--p-senior)"></i>', 'idoso');
    } else {
      item('<i class="ramp" style="background:linear-gradient(90deg,' + [0, 0.33, 0.66, 1].map(rampColor).join(',') + ')"></i>', 'primeiro → último da fila');
    }
    item('<i class="bagmark"></i>', 'mala de mão');
    item('<i class="ring"></i>', 'guardando mala ou esperando o vizinho levantar');
  }

  function renderStrategyList() {
    var ul = $('#strategyList');
    ul.textContent = '';
    allStrategies().forEach(function (st) {
      var li = el('li');
      var label = el('label', 'check');
      label.title = st.desc;
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.indexOf(st.id) >= 0;
      cb.addEventListener('change', function () {
        if (cb.checked) state.selected.push(st.id);
        else
          state.selected = state.selected.filter(function (id) {
            return id !== st.id;
          });
        buildLanes();
        resetSims();
      });
      var name = el('span', null, st.name);
      label.append(cb, name);
      li.append(label);
      if (st.custom) {
        var edit = el('button', 'icon-btn', 'editar');
        edit.type = 'button';
        edit.addEventListener('click', function () {
          openEditor(st.source);
        });
        li.append(edit);
      }
      ul.append(li);
    });
  }

  function bindControls() {
    var cfg = state.cfg;
    function slider(id, outId, get, set, show) {
      var input = $('#' + id);
      input.value = get();
      $('#' + outId).textContent = show(get());
      input.addEventListener('input', function () {
        set(Number(input.value));
        $('#' + outId).textContent = show(get());
        regenerate();
      });
    }
    var pct = function (v) {
      return Math.round(v * 100) + '%';
    };
    slider('rows', 'rowsOut', function () { return cfg.rows; }, function (v) { cfg.rows = v; layoutLanes(); }, String);
    slider('occ', 'occOut', function () { return cfg.occupancy * 100; }, function (v) { cfg.occupancy = v / 100; }, function (v) { return pct(v / 100); });
    slider('fam', 'famOut', function () { return cfg.familyShare * 100; }, function (v) { cfg.familyShare = v / 100; }, function (v) { return pct(v / 100); });
    slider('bag', 'bagOut', function () { return cfg.bagRate * 100; }, function (v) { cfg.bagRate = v / 100; }, function (v) { return pct(v / 100); });

    $('#perSide').value = cfg.perSide;
    $('#perSide').addEventListener('change', function (ev) {
      cfg.perSide = Number(ev.target.value);
      layoutLanes();
      regenerate();
    });

    var seed = $('#seed');
    seed.value = state.seed;
    seed.addEventListener('change', function () {
      state.seed = Math.max(1, Math.floor(Number(seed.value)) || 1);
      seed.value = state.seed;
      regenerate();
    });
    $('#reroll').addEventListener('click', function () {
      state.seed = 1 + Math.floor(Math.random() * 99999);
      seed.value = state.seed;
      regenerate();
    });

    [['keepGroups', 'keepGroups'], ['preboard', 'preboard']].forEach(function (pair) {
      var cb = $('#' + pair[0]);
      cb.checked = state[pair[1]];
      cb.addEventListener('change', function () {
        state[pair[1]] = cb.checked;
        resetSims();
      });
    });

    $('#play').addEventListener('click', function () {
      var allDone = state.lanes.every(function (l) {
        return !l.sim || l.sim.done;
      });
      if (allDone) resetSims();
      state.playing = !state.playing;
      updateUI();
    });
    $('#reset').addEventListener('click', resetSims);

    setSeg('speed', state.speed);
    onSeg('speed', function (v) {
      state.speed = Number(v);
    });
    setSeg('colorMode', state.colorMode);
    onSeg('colorMode', function (v) {
      state.colorMode = v;
      renderLegend();
      drawAll();
    });

    $('#newStrategy').addEventListener('click', function () {
      openEditor(null);
    });
    $('#runCompare').addEventListener('click', runCompare);

    if (window.ResizeObserver) new ResizeObserver(layoutLanes).observe($('#stage'));
    else window.addEventListener('resize', layoutLanes);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      readColors();
      drawAll();
    });
  }

  /* ---------- comparação estatística ---------- */

  var compareToken = 0;

  function runCompare() {
    var token = ++compareToken;
    var trials = Number($('#trials').value);
    var cfg = Object.assign({}, state.cfg);
    var opts = { keepGroups: state.keepGroups, preboard: state.preboard };
    var rows = allStrategies().map(function (st) {
      return { st: st, times: [], inter: 0, travel: 0, error: st.error || null };
    });
    var prog = $('#compareProgress');
    var btn = $('#runCompare');
    prog.hidden = false;
    btn.disabled = true;
    var i = 0;

    function chunk() {
      if (token !== compareToken) return;
      var t0 = performance.now();
      while (i < trials && performance.now() - t0 < 30) {
        var seed = state.seed + 1000 + i * 7919;
        var pax = S.generatePassengers(cfg, seed);
        rows.forEach(function (r) {
          if (r.error) return;
          try {
            var order = S.buildOrder(pax, r.st, cfg, opts, seed + 5);
            var out = new S.Simulation(cfg, order, seed + 9).run(0.2);
            r.times.push(out.time);
            r.inter += out.interferences;
            r.travel += out.meanTravel;
          } catch (e) {
            r.error = e.message;
          }
        });
        i++;
      }
      prog.firstElementChild.style.width = (i / trials) * 100 + '%';
      if (i < trials) setTimeout(chunk, 0);
      else {
        prog.hidden = true;
        btn.disabled = false;
        renderCompare(rows, trials, cfg);
      }
    }
    chunk();
  }

  function renderCompare(rows, trials, cfg) {
    var box = $('#compareResult');
    box.textContent = '';
    var ok = rows.filter(function (r) {
      return !r.error && r.times.length;
    });
    ok.forEach(function (r) {
      var n = r.times.length;
      r.mean = r.times.reduce(function (a, b) { return a + b; }, 0) / n;
      r.sd = Math.sqrt(r.times.reduce(function (a, b) { return a + (b - r.mean) * (b - r.mean); }, 0) / Math.max(1, n - 1));
      r.min = Math.min.apply(null, r.times);
      r.max = Math.max.apply(null, r.times);
    });
    ok.sort(function (a, b) {
      return a.mean - b.mean;
    });
    if (!ok.length) return;
    var best = ok[0];
    var worst = ok[ok.length - 1];
    var scale = Math.max.apply(null, ok.map(function (r) { return r.max; }));

    var verdict = el('p', 'verdict');
    verdict.innerHTML =
      '<b></b> foi a mais rápida: ' + fmt(best.mean) + ' em média' +
      (ok.length > 1 ? ', ' + Math.round((1 - best.mean / worst.mean) * 100) + '% menos tempo que <b></b> (' + fmt(worst.mean) + ').' : '.');
    var bs = verdict.querySelectorAll('b');
    bs[0].textContent = best.st.name;
    if (bs[1]) bs[1].textContent = worst.st.name;
    box.append(verdict);

    var wrap = el('div', 'table-scroll');
    var table = el('table', 'results');
    table.innerHTML =
      '<thead><tr><th></th><th>Estratégia</th><th>Tempo de embarque (min:s)</th><th class="num">Média</th>' +
      '<th class="num hide-narrow">Mais rápido – mais lento</th><th class="num">vs. melhor</th><th class="num hide-narrow">Trocas de assento</th></tr></thead>';
    var tb = el('tbody');
    ok.forEach(function (r, idx) {
      var tr = el('tr');
      tr.append(el('td', 'num', idx + 1 + 'º'), el('td', 'name', r.st.name));
      var cell = el('td', 'barcell');
      var track = el('div', 'track');
      var fill = el('div', 'fill');
      fill.style.width = (r.mean / scale) * 100 + '%';
      var whisk = el('div', 'whisk');
      whisk.style.left = (r.min / scale) * 100 + '%';
      whisk.style.width = ((r.max - r.min) / scale) * 100 + '%';
      track.append(fill, whisk);
      track.title = r.st.name + ': média ' + fmt(r.mean) + ' (desvio ' + fmt(r.sd) + '), de ' + fmt(r.min) + ' a ' + fmt(r.max);
      cell.append(track);
      tr.append(
        cell,
        el('td', 'num', fmt(r.mean)),
        el('td', 'num hide-narrow', fmt(r.min) + ' – ' + fmt(r.max)),
        el('td', 'num', idx === 0 ? '—' : '+' + Math.round((r.mean / best.mean - 1) * 100) + '%'),
        el('td', 'num hide-narrow', Math.round(r.inter / r.times.length))
      );
      tb.append(tr);
    });
    table.append(tb);
    wrap.append(table);
    box.append(wrap);

    var note =
      'Barra: tempo médio de ' + trials + ' voos. Traço: do voo mais rápido ao mais lento. ' +
      cfg.rows + ' fileiras, ' + Math.round(cfg.occupancy * 100) + '% de ocupação, ' +
      Math.round(cfg.familyShare * 100) + '% em família, ' + Math.round(cfg.bagRate * 100) + '% com mala' +
      (state.keepGroups ? ', grupos embarcando juntos' : ', grupos separados pela estratégia') +
      (state.preboard ? ', famílias com crianças primeiro.' : '.');
    box.append(el('p', 'chart-note', note));
    rows.forEach(function (r) {
      if (r.error) box.append(el('p', 'error', r.st.name + ': erro na estratégia (' + r.error + ').'));
    });
  }

  /* ---------- editor de estratégias ---------- */

  var ed = { id: null, type: 'zones', zone: 1, grid: null, rows: 0, perSide: 0 };
  var SAMPLE = '// Exemplo: fileira por fileira, do fundo para a frente,\n// e dentro da fileira a janela entra antes do corredor.\nreturn (ctx.rows - p.row) * 10 + p.fromWindow;';

  function openEditor(src) {
    var R = state.cfg.rows;
    var Sd = state.cfg.perSide;
    ed.id = src ? src.id : null;
    ed.type = src ? src.type : 'zones';
    ed.rows = R;
    ed.perSide = Sd;
    ed.zone = 1;
    // a grade é sempre editada no formato do avião atual
    ed.grid = [];
    for (var r = 1; r <= R; r++) {
      var line = [];
      for (var c = 0; c < 2 * Sd; c++) {
        var z = 1;
        if (src && src.type === 'zones') {
          z = zoneOf(src.grid, { row: r, side: c < Sd ? 0 : 1, fromWindow: c < Sd ? c : 2 * Sd - 1 - c }, { rows: R, perSide: Sd });
        }
        line.push(z);
      }
      ed.grid.push(line);
    }
    $('#editorTitle').textContent = src ? 'Editar estratégia' : 'Criar estratégia';
    $('#edName').value = src ? src.name : '';
    $('#edWithin').value = src && src.within ? src.within : 'random';
    $('#edSource').value = src && src.type === 'code' ? src.code : SAMPLE;
    $('#edDelete').hidden = !src;
    $('#edError').hidden = true;
    setEdType(ed.type);
    renderPalette();
    renderGrid();
    $('#editor').showModal();
  }

  function setEdType(t) {
    ed.type = t;
    setSeg('edType', t);
    $('#edZones').hidden = t !== 'zones';
    $('#edCode').hidden = t !== 'code';
  }

  function renderPalette() {
    var pal = $('#edPalette');
    pal.textContent = '';
    for (var z = 1; z <= ZONES; z++) {
      var b = el('button', null, z);
      b.type = 'button';
      b.dataset.z = z;
      b.style.background = 'var(--z' + z + ')';
      b.title = 'Grupo ' + z;
      b.setAttribute('aria-pressed', String(z === ed.zone));
      pal.append(b);
    }
  }

  function paintCell(cell) {
    var r = Number(cell.dataset.r);
    var c = Number(cell.dataset.c);
    ed.grid[r][c] = ed.zone;
    cell.style.background = 'var(--z' + ed.zone + ')';
    cell.textContent = ed.zone;
  }

  function renderGrid() {
    var grid = $('#edGrid');
    var R = ed.rows;
    var Sd = ed.perSide;
    grid.textContent = '';
    grid.style.gridTemplateColumns = '22px repeat(' + R + ', 21px)';
    grid.append(el('div'));
    for (var r = 0; r < R; r++) {
      var h = el('div', 'hdr', r + 1);
      h.dataset.row = r;
      h.title = 'Pintar a fileira ' + (r + 1);
      grid.append(h);
    }
    for (var c = 0; c < 2 * Sd; c++) {
      if (c === Sd) grid.append(el('div', 'gap', '← frente · corredor · fundo →'));
      var lh = el('div', 'hdr', S.LETTERS[c]);
      lh.dataset.col = c;
      lh.title = 'Pintar todos os assentos ' + S.LETTERS[c];
      grid.append(lh);
      for (r = 0; r < R; r++) {
        var cell = el('div', 'cell', ed.grid[r][c]);
        cell.dataset.r = r;
        cell.dataset.c = c;
        cell.style.background = 'var(--z' + ed.grid[r][c] + ')';
        grid.append(cell);
      }
    }
  }

  function bindEditor() {
    var dlg = $('#editor');
    var grid = $('#edGrid');
    var painting = false;

    onSeg('edType', setEdType);
    $('#edPalette').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      ed.zone = Number(b.dataset.z);
      renderPalette();
    });

    grid.addEventListener('pointerdown', function (ev) {
      var t = ev.target;
      if (t.classList.contains('cell')) {
        painting = true;
        paintCell(t);
        ev.preventDefault();
      } else if (t.dataset.row != null) {
        grid.querySelectorAll('.cell[data-r="' + t.dataset.row + '"]').forEach(paintCell);
      } else if (t.dataset.col != null) {
        grid.querySelectorAll('.cell[data-c="' + t.dataset.col + '"]').forEach(paintCell);
      }
    });
    grid.addEventListener('pointermove', function (ev) {
      if (!painting) return;
      var t = document.elementFromPoint(ev.clientX, ev.clientY);
      if (t && t.classList.contains('cell') && grid.contains(t)) paintCell(t);
    });
    window.addEventListener('pointerup', function () {
      painting = false;
    });

    $('#edCancel').addEventListener('click', function () {
      dlg.close();
    });
    $('#edDelete').addEventListener('click', function () {
      state.customs = state.customs.filter(function (c) { return c.id !== ed.id; });
      state.selected = state.selected.filter(function (id) { return id !== ed.id; });
      saveCustoms();
      dlg.close();
      refreshStrategies();
    });

    $('#editorForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = $('#edError');
      var name = $('#edName').value.trim();
      if (!name) return;
      var c = { id: ed.id || 'custom-' + Date.now().toString(36), name: name, type: ed.type };
      if (ed.type === 'code') {
        c.code = $('#edSource').value;
        try {
          var fn = new Function('p', 'ctx', c.code);
          var probe = state.passengers[0];
          var v = fn(probe, { rows: state.cfg.rows, perSide: state.cfg.perSide, total: state.passengers.length, random: Math.random });
          if (typeof v !== 'number' || v !== v) throw new Error('a fórmula precisa devolver um número (use "return").');
        } catch (e) {
          err.textContent = 'Não foi possível usar a fórmula: ' + e.message;
          err.hidden = false;
          return;
        }
      } else {
        c.grid = ed.grid;
        c.within = $('#edWithin').value;
      }
      var idx = state.customs.findIndex(function (x) { return x.id === c.id; });
      if (idx >= 0) state.customs[idx] = c;
      else state.customs.push(c);
      if (state.selected.indexOf(c.id) < 0) state.selected.push(c.id);
      saveCustoms();
      dlg.close();
      refreshStrategies();
    });
  }

  function refreshStrategies() {
    renderStrategyList();
    buildLanes();
    resetSims();
  }

  /* ---------- início ---------- */

  readColors();
  bindControls();
  bindEditor();
  renderLegend();
  renderStrategyList();
  buildLanes();
  regenerate();
  requestAnimationFrame(frame);

  // gancho para testes automatizados
  window.__boarding = { state: state, resetSims: resetSims, runCompare: runCompare, openEditor: openEditor, drawAll: drawAll };
})();
