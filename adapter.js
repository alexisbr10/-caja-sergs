/* Conexión con Supabase: cuentas, roles y datos de la caja.
   Esta página no guarda contraseñas: las maneja Supabase Auth.
   La seguridad real está en las reglas (RLS) de supabase.sql. */
(function () {
  var cfg = window.CAJA_CONFIG || {};
  var texto = String(cfg.SUPABASE_URL || '') + String(cfg.SUPABASE_ANON_KEY || '');
  var ok = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase && !/TU-/.test(texto));
  var sb = ok ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
  var perfil = null;

  /* ---- nombres de campos: la página usa camelCase, la base usa snake_case ---- */
  var MAPAS = { movimientos: { traspasoId: 'traspaso_id', arqueoId: 'arqueo_id' }, arqueos: { ajusteId: 'ajuste_id' },
    solicitudes: { movimientoId: 'movimiento_id', resueltoPor: 'resuelto_por' }, documentos: { movimientoId: 'movimiento_id' } };
  /* Tablas donde solo se inserta (nadie, salvo el propietario, puede reescribir filas). */
  var SOLO_INSERTAR = { movimientos: 1, solicitudes: 1, documentos: 1 };
  function inv(m) { var r = {}; Object.keys(m).forEach(function (k) { r[m[k]] = k; }); return r; }
  function aFila(col, d) {
    var m = MAPAS[col] || {}, r = {};
    Object.keys(d).forEach(function (k) { if (d[k] !== undefined) r[m[k] || k] = d[k]; });
    return r;
  }
  function deFila(col, row) {
    var m = inv(MAPAS[col] || {}), o = {};
    Object.keys(row).forEach(function (k) {
      if (row[k] === null || k === 'id') return;
      o[m[k] || k] = row[k];
    });
    return o;
  }
  function mapErr(e) {
    var msg = (e && e.message) || '';
    if (/mes_cerrado/i.test(msg)) return { code: 'mes_cerrado', message: msg };
    var code = (e && (e.code === '42501' || /row-level security|permission denied|solo puede/i.test(msg))) ? 'invalid_argument' : 'unavailable';
    return { code: code, message: msg };
  }
  function nuevoId() { return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  async function traerTodo(tabla, max) {
    var out = [], desde = 0, pag = 1000;
    while (out.length < max) {
      var r = await sb.from(tabla).select('*').order('creado', { ascending: false }).range(desde, desde + pag - 1);
      if (r.error) throw r.error;
      out = out.concat(r.data);
      if (r.data.length < pag) break;
      desde += pag;
    }
    return out.slice(0, max);
  }

  /* Escucha una tabla: entrega los datos al inicio y cada vez que algo cambia. */
  function vigilar(tabla, ejecutar, error) {
    var vivo = true, timer = null, canal = null;
    function cargar() {
      if (!vivo) return;
      ejecutar().catch(function (e) { if (vivo && error) error(mapErr(e)); });
    }
    function pronto() { clearTimeout(timer); timer = setTimeout(cargar, 250); }
    cargar();
    try {
      canal = sb.channel('c-' + tabla + '-' + Math.random().toString(36).slice(2, 7))
        .on('postgres_changes', { event: '*', schema: 'public', table: tabla }, pronto)
        .subscribe();
    } catch (e) { canal = null; }
    var sondeo = setInterval(function () { if (!document.hidden) cargar(); }, 30000);
    return function () { vivo = false; clearTimeout(timer); clearInterval(sondeo); if (canal) { try { sb.removeChannel(canal); } catch (e) {} } };
  }

  function chk(r) { if (r.error) throw mapErr(r.error); }

  function snapDoc(id, row, col) {
    return { id: id, exists: !!row, data: function () { return row ? deFila(col, row) : undefined; }, metadata: {} };
  }

  function doc(path) {
    var p = path.split('/'), col = p[0], id = p[1];
    if (col === 'config' && id === 'empresa') {
      return {
        path: path, id: id,
        get: function () { return sb.from('empresa').select('*').eq('id', 1).maybeSingle().then(function (r) { return snapDoc('empresa', r.data, 'empresa'); }); },
        set: function (d) { var f = aFila('empresa', d); f.id = 1; return sb.from('empresa').upsert(f).then(chk); },
        update: function (d) { return sb.from('empresa').update(aFila('empresa', d)).eq('id', 1).then(chk); },
        delete: function () { return Promise.resolve(); },
        onSnapshot: function (fn, err) {
          return vigilar('empresa', function () {
            return sb.from('empresa').select('*').eq('id', 1).maybeSingle().then(function (r) { if (r.error) throw r.error; fn(snapDoc('empresa', r.data, 'empresa')); });
          }, err);
        }
      };
    }
    return {
      path: path, id: id,
      get: function () { return sb.from(col).select('*').eq('id', id).maybeSingle().then(function (r) { return snapDoc(id, r.data, col); }); },
      set: function (d) { var f = aFila(col, d); f.id = id; return (SOLO_INSERTAR[col] ? sb.from(col).insert(f) : sb.from(col).upsert(f)).then(chk); },
      update: function (d) {
        return sb.from(col).update(aFila(col, d)).eq('id', id).select().then(function (r) {
          if (r.error) throw mapErr(r.error);
          if (!r.data || !r.data.length) throw { code: 'invalid_argument', message: 'Sin permiso o no existe' };
        });
      },
      delete: function () { return sb.from(col).delete().eq('id', id).then(chk); }
    };
  }

  function coleccion(col, lim) {
    return {
      limit: function (n) { return coleccion(col, n); },
      add: function (d) { var id = nuevoId(); return doc(col + '/' + id).set(d).then(function () { return doc(col + '/' + id); }); },
      doc: function (id) { return doc(col + '/' + (id || nuevoId())); },
      onSnapshot: function (fn, err) {
        return vigilar(col, function () {
          return traerTodo(col, lim || 1000).then(function (rows) {
            var docs = rows.map(function (r) { return snapDoc(r.id, r, col); });
            fn({ docs: docs, size: docs.length, empty: !docs.length });
          });
        }, err);
      }
    };
  }
  var dbAd = { doc: doc, collection: function (c) { return coleccion(c); } };

  /* ---- usuario actual ---- */
  function iniciales(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (s) { return s[0] || ''; }).join('').toUpperCase() || '?'; }
  function avatar(n) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" rx="22" fill="#1c5cab"/><text x="22" y="28" font-size="16" font-family="sans-serif" font-weight="700" fill="#fff" text-anchor="middle">' + iniciales(n).replace(/[<>&]/g, '') + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function esAdmin() { return !!perfil && perfil.rol === 'admin'; }
  function puedeEscribir() { return !!perfil && (perfil.rol === 'admin' || perfil.rol === 'cajero'); }
  var userAd = {
    isOwner: function () { return Promise.resolve(esAdmin()); },
    canEdit: function () { return Promise.resolve(esAdmin()); },
    can: function () { return Promise.resolve(puedeEscribir()); },
    id: function () { return Promise.resolve(perfil ? perfil.id : null); },
    me: function () {
      var n = perfil ? (perfil.nombre || perfil.email) : '';
      return Promise.resolve({ id: perfil ? perfil.id : null, name: n, email: perfil ? perfil.email : null, avatarUrl: avatar(n), isOwner: esAdmin(), canEdit: esAdmin() });
    },
    profiles: async function (ids) {
      var out = {};
      ids.forEach(function (i) { out[i] = { id: i, name: '', avatarUrl: avatar('?'), isMe: !!perfil && perfil.id === i }; });
      if (!ids.length) return out;
      var r = await sb.from('profiles').select('id,nombre,email').in('id', ids);
      (r.data || []).forEach(function (u) { var n = u.nombre || u.email || ''; out[u.id] = { id: u.id, name: n, avatarUrl: avatar(n), isMe: !!perfil && perfil.id === u.id }; });
      return out;
    }
  };

  /* ---- descargas (CSV y PDF) ---- */
  var dlAd = {
    save: function (r) {
      var blob = (r.data instanceof Blob) ? r.data : new Blob([r.data], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = r.filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      return Promise.resolve({ status: 'saved' });
    }
  };

  /* ---- fotos de comprobantes (Storage privado) ---- */
  var BUCKET = 'comprobantes';
  window.CajaStorage = {
    subir: async function (path, blob) {
      var r = await sb.storage.from(BUCKET).upload(path, blob, { contentType: (blob && blob.type) || 'image/jpeg', upsert: false });
      if (r.error) throw r.error;
    },
    url: async function (path) {
      var r = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
      if (r.error) throw r.error;
      return r.data.signedUrl;
    }
  };

  window.claude = {
    use: function (n) {
      if (n === 'db') return Promise.resolve(ok && perfil ? dbAd : null);
      if (n === 'user') return Promise.resolve(userAd);
      if (n === 'downloads') return Promise.resolve(dlAd);
      return Promise.resolve(null);
    }
  };

  /* ---- cuentas ---- */
  window.CajaAuth = {
    configurado: ok,
    sesion: async function () {
      if (!ok) return null;
      var r = await sb.auth.getSession();
      var s = r.data && r.data.session;
      if (!s) { perfil = null; return null; }
      var pr = await sb.from('profiles').select('*').eq('id', s.user.id).maybeSingle();
      perfil = pr.data || null;
      return { user: s.user, perfil: perfil };
    },
    ingresar: async function (email, pass) {
      var r = await sb.auth.signInWithPassword({ email: email, password: pass });
      if (r.error) throw r.error;
    },
    /* Solo el administrador: crea la cuenta con un cliente aparte para no cerrar su propia sesión. */
    crearUsuario: async function (nombre, email, pass, rol) {
      if (!esAdmin()) throw { message: 'Sin permiso' };
      var otro = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      var r = await otro.auth.signUp({ email: email, password: pass, options: { data: { nombre: nombre } } });
      if (r.error) throw r.error;
      var u = r.data && r.data.user;
      if (!u || (u.identities && !u.identities.length)) throw { message: 'already registered' };
      if (rol && rol !== 'pendiente') {
        var q = await sb.from('profiles').update({ rol: rol }).eq('id', u.id).select();
        if (q.error) throw q.error;
        if (!q.data || !q.data.length) throw { message: 'Usuario creado, pero no se pudo asignar el rol. Cámbialo en la lista.' };
      }
      return u;
    },
    salir: async function () { await sb.auth.signOut(); perfil = null; },
    listarUsuarios: async function () {
      var r = await sb.from('profiles').select('*').order('creado', { ascending: true });
      if (r.error) throw r.error;
      return r.data;
    },
    cambiarRol: async function (id, rol) {
      var r = await sb.from('profiles').update({ rol: rol }).eq('id', id).select();
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw { message: 'Sin permiso' };
    },
    resolverSolicitud: async function (id, aprobar, respuesta) {
      var r = await sb.rpc('resolver_solicitud', { p_id: id, p_aprobar: !!aprobar, p_resp: respuesta || null });
      if (r.error) throw mapErr(r.error);
    },
    cambiarClave: async function (id, pass) {
      var r = await sb.rpc('admin_cambiar_clave', { p_uid: id, p_clave: pass });
      if (r.error) throw r.error;
    },
    mensajeError: function (e) {
      var m = String((e && e.message) || '');
      if (/invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
      if (/already registered|already been registered/i.test(m)) return 'Ese correo ya tiene una cuenta. Usa "Ingresar".';
      if (/at least \d+ characters|weak/i.test(m)) return 'La contraseña es muy corta. Usa al menos 6 caracteres.';
      if (/not confirmed/i.test(m)) return 'Confirma tu correo antes de ingresar. Revisa tu bandeja de entrada.';
      if (/al menos 6|at least \d+ characters|weak/i.test(m)) return 'La contraseña es muy corta. Usa al menos 6 caracteres.';
      if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos.';
      if (/valid email|invalid email/i.test(m)) return 'Escribe un correo válido.';
      if (/failed to fetch|network/i.test(m)) return 'No hay conexión. Revisa tu internet.';
      return 'No se pudo completar. Intenta de nuevo.';
    }
  };
})();
