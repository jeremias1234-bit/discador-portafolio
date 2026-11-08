// Cabecera con el menú (según los permisos del usuario) y el contenido de cada pantalla.
import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSesion, useYo } from '../sesion';
import { menuDe } from '../menu';
import { useTiempoReal } from '../tiempoReal';

const ROL: Record<string, string> = { vendedor: 'Vendedor', supervisor: 'Supervisor', admin: 'Administrador' };

export function Marco() {
  const yo = useYo();
  const { salir, puede } = useSesion();
  const { conectado } = useTiempoReal();
  const location = useLocation();
  const desplegable = useRef<HTMLDetailsElement>(null);
  const menu = menuDe(yo, puede);
  const admin = menu.filter((m) => m.grupo === 'admin');
  const principales = menu.filter((m) => m.grupo !== 'admin');
  // "Llamar" (la última) va después del desplegable de administración
  const corte = principales.at(-1)?.texto === 'Llamar' ? principales.length - 1 : principales.length;

  // Al elegir una sección el desplegable se cierra
  useEffect(() => {
    desplegable.current?.removeAttribute('open');
  }, [location.pathname]);

  return (
    <div className="marco">
      <header className="cabecera">
        <div className="marca">
          <img src="/globo.png" alt="" width={34} height={34} />
          <div>
            <strong>DISCADOR</strong>
            <span>IVR · PREDICTIVO · LEADS</span>
          </div>
        </div>
        <nav>
          {principales.slice(0, corte).map((m) => <NavLink key={m.ruta} to={m.ruta}>{m.texto}</NavLink>)}
          {admin.length > 0 && (
            <details className={`desplegable ${admin.some((m) => location.pathname.startsWith(m.ruta)) ? 'activo' : ''}`} ref={desplegable}>
              <summary>Administración ▾</summary>
              <div className="desplegable-menu" onClick={() => desplegable.current?.removeAttribute('open')}>
                {admin.map((m) => <NavLink key={m.ruta} to={m.ruta}>{m.texto}</NavLink>)}
              </div>
            </details>
          )}
          {principales.slice(corte).map((m) => <NavLink key={m.ruta} to={m.ruta}>{m.texto}</NavLink>)}
        </nav>
        <div className="usuario">
          {!conectado && <span className="chip peligro">Sin conexión con el servidor</span>}
          <span>
            <strong>{yo.nombre}</strong> <span className="suave chico">{ROL[yo.rol]}</span>
          </span>
          <button onClick={() => void salir()}>Salir</button>
        </div>
      </header>
      <main className="contenido">
        <Outlet />
      </main>
    </div>
  );
}
