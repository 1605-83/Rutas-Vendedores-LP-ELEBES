// Servicio GPS del panel "Rutas de vendedores" (LP - ELEBES) - Cloudflare Worker.
// Entra a Axum GPS con el usuario y la clave guardados como SECRETOS del worker (nunca en este codigo)
// y devuelve al panel solo lo necesario. Las posiciones y visitas piden la clave del panel.
//
// Secretos a cargar en Cloudflare (Settings > Variables and Secrets, tipo "Secret"):
//   AXUM_GPS_USUARIO   usuario de Axum GPS
//   AXUM_GPS_CLAVE     contrasena de Axum GPS
//   PANEL_CLAVE        clave que se escribe en el panel para ver el mapa (la elige Bruno)
//
// Rutas:
//   GET /estado                    sin clave: si conecta y cuantos vendedores transmiten (sin posiciones)
//   GET /funciones                 sin clave: lista de funciones del servicio de Axum y sus parametros (WSDL)
//   GET /posiciones                con clave: lastPositions (donde esta cada vendedor ahora)
//   GET /visitas?fecha=AAAA-MM-DD  con clave: pasoPoprPDVAt (por que clientes paso cada uno y cuanto estuvo)
//   GET /jornada?fecha=AAAA-MM-DD  con clave: primerUltimaVisitaAt (hora de inicio y fin)
// La clave del panel va en el encabezado "X-Clave".

const AXUM = 'https://gps.axumvm.com.ar';
const ORIGENES = ['https://1605-83.github.io', 'http://localhost:8767', 'http://localhost:8768'];
const CACHE_SEG = 60;          // lecturas livianas: lo pedido hace menos de un minuto se reutiliza
const SESION_SEG = 15 * 60;    // la cookie de Axum se reutiliza 15 minutos

let sesion = null;             // {cookie, hasta}

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGENES.includes(o) ? o : ORIGENES[0],
    'Access-Control-Allow-Headers': 'X-Clave, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req, datos, estado = 200) =>
  new Response(JSON.stringify(datos), { status: estado, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) } });

// compara la clave sin cortar en el primer caracter distinto
function igual(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const campo = (html, nombre) => {
  const m = html.match(new RegExp('name="' + nombre.replace(/\$/g, '\\$') + '"[^>]*value="([^"]*)"')) ||
            html.match(new RegExp('id="' + nombre + '"[^>]*value="([^"]*)"'));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
};
const cookiesDe = (resp) => {
  const lista = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [resp.headers.get('Set-Cookie') || ''];
  return lista.filter(Boolean).map(c => c.split(';')[0]).join('; ');
};

// Ingreso a Axum GPS (ASP.NET WebForms): pedir el login, sacar los campos escondidos y mandar el formulario
async function entrar(env) {
  if (sesion && sesion.hasta > Date.now()) return sesion.cookie;
  if (!env.AXUM_GPS_USUARIO || !env.AXUM_GPS_CLAVE) throw new Error('Faltan los secretos AXUM_GPS_USUARIO y AXUM_GPS_CLAVE');
  // se presenta como un navegador comun: algunos sistemas viejos rechazan pedidos sin estos encabezados
  const NAV = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-AR,es;q=0.9' };
  const r1 = await fetch(AXUM + '/Login.aspx', { redirect: 'manual', headers: NAV });
  const html = await r1.text();
  const c1 = cookiesDe(r1);
  const form = new URLSearchParams();
  form.set('__VIEWSTATE', campo(html, '__VIEWSTATE'));
  form.set('__VIEWSTATEGENERATOR', campo(html, '__VIEWSTATEGENERATOR'));
  const ev = campo(html, '__EVENTVALIDATION'); if (ev) form.set('__EVENTVALIDATION', ev);
  form.set('UserName', env.AXUM_GPS_USUARIO);
  form.set('Password', env.AXUM_GPS_CLAVE);
  form.set('Button1', campo(html, 'Button1') || 'Ingresar');
  const r2 = await fetch(AXUM + '/Login.aspx', {
    method: 'POST', redirect: 'manual', body: form.toString(),
    headers: { ...NAV, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c1, 'Origin': AXUM, 'Referer': AXUM + '/Login.aspx' },
  });
  const c2 = cookiesDe(r2);
  const cookie = [c1, c2].filter(Boolean).join('; ');
  // si entro bien, Axum redirige fuera del login (o deja de mostrar el formulario) y entrega la cookie de autenticacion
  const destino = r2.headers.get('Location') || '';
  const html2 = r2.status === 200 ? await r2.text() : '';
  const fuera = destino && !/login\.aspx/i.test(destino);
  const sinForm = r2.status === 200 && html2 && !/id="Password"/i.test(html2);
  if (!fuera && !sinForm && !/ASPXAUTH|\.AUTH/i.test(c2)) {
    // diagnostico sin datos sensibles: estado, a donde redirige, nombres de cookies y el mensaje que muestra la pagina
    const nombres = c2.split('; ').map(c => c.split('=')[0]).filter(Boolean).join(',') || 'ninguna';
    const txt = html2.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const msj = (txt.match(/[^.]{0,80}(incorrect|inv[aá]lid|error|bloquead|no existe|vencid)[^.]{0,80}/i) || [''])[0].trim();
    const alerta = ((html2.match(/alert\(\s*['"]([^'"]{1,160})['"]/i) || [])[1] || '').trim();   // mensajes que Axum muestra con un cartel
    const pagina = txt.trim().slice(0, 220);   // texto visible de la pantalla de ingreso (no tiene datos de nadie)
    throw new Error(`Axum GPS no acepto el ingreso (respuesta ${r2.status}${destino ? ', va a ' + destino : ''}, cookies: ${nombres}` +
      `${msj ? ', mensaje: ' + msj : ''}${alerta ? ', cartel: ' + alerta : ''}, viewstate: ${form.get('__VIEWSTATE') ? 'si' : 'NO'}, pantalla: ${pagina})`);
  }
  sesion = { cookie, hasta: Date.now() + SESION_SEG * 1000 };
  return cookie;
}

// Llamada a una funcion del servicio LocationService.asmx (POST en JSON)
async function llamar(env, funcion, params = {}) {
  for (let intento = 0; intento < 2; intento++) {
    const cookie = await entrar(env);
    const r = await fetch(AXUM + '/LocationService.asmx/' + funcion, {
      // todas las funciones piden el usuario de Axum como primer dato (userName)
      method: 'POST', redirect: 'manual', body: JSON.stringify({ userName: env.AXUM_GPS_USUARIO, ...params }),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cookie': cookie },
    });
    if (r.status === 302 || r.status === 401) { sesion = null; continue; }   // sesion vencida: entra de nuevo una vez
    const txt = await r.text();
    if (!r.ok) throw new Error(`Axum respondio ${r.status} en ${funcion}: ${txt.slice(0, 200)}`);
    const j = JSON.parse(txt);
    let d = j && 'd' in j ? j.d : j;   // los .asmx devuelven {d: ...}
    if (typeof d === 'string' && /^\s*[\[{]/.test(d)) { try { d = JSON.parse(d); } catch (e) {} }   // a veces el JSON viene como texto
    return d;
  }
  throw new Error('No se pudo mantener la sesion de Axum GPS');
}

// funciones con fecha (aDate): Axum no documenta el formato; se prueban los habituales y se recuerda el que anda
const FORMATOS = [f => f.split('-').reverse().join('/'), f => f, f => { const [y, m, d] = f.split('-'); return `${m}/${d}/${y}`; }, f => f.replace(/-/g, '')];
let formatoOk = null;
async function conFecha(env, funcion, fecha, extra = {}) {
  const orden = formatoOk == null ? FORMATOS.map((_, i) => i) : [formatoOk, ...FORMATOS.map((_, i) => i).filter(i => i !== formatoOk)];
  let ultimo = null;
  for (const i of orden) {
    try {
      const d = await llamar(env, funcion, { aDate: FORMATOS[i](fecha), ...extra });
      if (d != null && !(typeof d === 'string' && /error|invalid|formato/i.test(d))) { formatoOk = i; return d; }
    } catch (e) { ultimo = e; }
  }
  if (ultimo) throw ultimo;
  return null;
}

// forma de los datos sin los datos: nombres de campos y valores enmascarados (digitos = 9, letras = x)
function forma(d) {
  const mascara = v => v == null ? null : typeof v === 'number' ? 'numero' : typeof v === 'boolean' ? 'si/no'
    : String(v).slice(0, 40).replace(/[0-9]/g, '9').replace(/[A-Za-zÁÉÍÓÚÑáéíóúñ]/g, 'x');
  const uno = x => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Array.isArray(v) ? `lista(${v.length})` : typeof v === 'object' && v ? uno(v) : mascara(v)])) : mascara(x);
  if (Array.isArray(d)) return { tipo: 'lista', cantidad: d.length, ejemplo: d.length ? (Array.isArray(d[0]) ? d[0].map(mascara) : uno(d[0])) : null };
  return { tipo: typeof d, ejemplo: uno(d) };
}

// lo pedido hace menos de CACHE_SEG se toma de la cache de Cloudflare
async function conCache(clave, fn) {
  const cache = caches.default, k = new Request('https://cache.local/' + encodeURIComponent(clave));
  const hit = await cache.match(k); if (hit) return hit.json();
  const datos = await fn();
  await cache.put(k, new Response(JSON.stringify(datos), { headers: { 'Cache-Control': `max-age=${CACHE_SEG}` } }));
  return datos;
}

const hoyAR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    const url = new URL(req.url), ruta = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (ruta === '/' || ruta === '/estado') {
        const pos = await conCache('posiciones', () => llamar(env, 'lastPositions', {}));
        const lista = Array.isArray(pos) ? pos : [];
        return json(req, { ok: true, conectado: true, vendedores: lista.length, hora: new Date().toISOString() });
      }
      if (ruta === '/funciones') {
        // firmas del servicio (no son datos): sirve para ajustar los parametros de cada funcion
        const cookie = await entrar(env);
        const r = await fetch(AXUM + '/LocationService.asmx?WSDL', { headers: { 'Cookie': cookie } });
        const xml = await r.text();
        const ops = {};
        for (const m of xml.matchAll(/<s:element name="([^"]+)">\s*<s:complexType>\s*(?:<s:sequence>([\s\S]*?)<\/s:sequence>|<s:sequence\s*\/>)?/g)) {
          if (m[1].endsWith('Response')) continue;
          ops[m[1]] = [...(m[2] || '').matchAll(/<s:element[^>]*name="([^"]+)"[^>]*type="([^"]+)"/g)].map(x => `${x[1]}:${x[2].replace(/^s:/, '')}`);
        }
        return json(req, { ok: r.ok, estado: r.status, cantidad: Object.keys(ops).length, funciones: ops });
      }
      if (ruta === '/estructura') {
        // solo la forma de cada respuesta (sin posiciones, nombres ni codigos reales) para armar el panel
        const f = hoyAR(), out = {};
        for (const [n, fn] of [['lastPositions', () => llamar(env, 'lastPositions')], ['pasoPoprPDVAt', () => conFecha(env, 'pasoPoprPDVAt', f)],
                               ['primerUltimaVisitaAt', () => conFecha(env, 'primerUltimaVisitaAt', f)], ['vendedoresId', () => llamar(env, 'vendedoresId', { username: env.AXUM_GPS_USUARIO })]]) {
          try { out[n] = forma(await fn()); } catch (e) { out[n] = { error: String(e.message || e).slice(0, 300) }; }
        }
        return json(req, { ok: true, fecha: f, formatoFecha: formatoOk, estructura: out });
      }
      // de aca en adelante hay datos de personas: piden la clave del panel
      if (!env.PANEL_CLAVE || !igual(req.headers.get('X-Clave'), env.PANEL_CLAVE)) return json(req, { ok: false, error: 'Clave del panel incorrecta' }, 401);
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('fecha') || '') ? url.searchParams.get('fecha') : hoyAR();
      if (ruta === '/posiciones') return json(req, { ok: true, datos: await conCache('posiciones', () => llamar(env, 'lastPositions', {})) });
      if (ruta === '/visitas') return json(req, { ok: true, fecha, datos: await conCache('visitas-' + fecha, () => conFecha(env, 'pasoPoprPDVAt', fecha)) });
      if (ruta === '/jornada') return json(req, { ok: true, fecha, datos: await conCache('jornada-' + fecha, () => conFecha(env, 'primerUltimaVisitaAt', fecha)) });
      return json(req, { ok: false, error: 'Ruta desconocida' }, 404);
    } catch (e) {
      return json(req, { ok: false, error: String(e.message || e) }, 502);
    }
  },
};
