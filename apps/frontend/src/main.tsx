import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Marco } from './componentes/Marco';
import './estilos.css';
import { Login } from './paginas/Login';
import { Audios } from './paginas/Audios';
import { Bitacora } from './paginas/Bitacora';
import { CampanaDetalle } from './paginas/CampanaDetalle';
import { Configuracion } from './paginas/Configuracion';
import { Gateways } from './paginas/Gateways';
import { Grabaciones } from './paginas/Grabaciones';
import { Ivr } from './paginas/Ivr';
import { Leads } from './paginas/Leads';
import { MisAvisos } from './paginas/MisAvisos';
import { MisLlamadas } from './paginas/MisLlamadas';
import { Monitor } from './paginas/Monitor';
import { Reportes } from './paginas/Reportes';
import { RevisionAmd } from './paginas/RevisionAmd';
import { NoLlame } from './paginas/NoLlame';
import { Campanas } from './paginas/Campanas';
import { Puesto } from './paginas/Puesto';
import { Usuarios } from './paginas/Usuarios';
import { menuDe } from './menu';
import { ProveedorSesion, useSesion } from './sesion';
import { ProveedorTelefono } from './telefono/contexto';
import { ProveedorTiempoReal } from './tiempoReal';

const PAGINAS: Record<string, () => React.JSX.Element> = {
  '/puesto': Puesto, '/mis-llamadas': MisLlamadas, '/monitor': Monitor, '/reportes': Reportes, '/grabaciones': Grabaciones,
  '/campanas': Campanas, '/usuarios': Usuarios, '/audios': Audios, '/gateways': Gateways, '/configuracion': Configuracion,
  '/no-llame': NoLlame, '/bitacora': Bitacora, '/revision-amd': RevisionAmd, '/ivr': Ivr, '/mis-avisos': MisAvisos, '/leads': Leads,
};

function Aplicacion() {
  const { yo, cargando, puede } = useSesion();
  if (cargando) return null;
  if (!yo) return <Login />;
  // Solo existen las rutas del menú del usuario: cualquier otra lleva a su pantalla de inicio
  // (evita, por ejemplo, que un vendedor quede en /monitor heredado de la sesión anterior)
  const menu = menuDe(yo, puede);
  const inicio = menu[0]?.ruta ?? '/puesto';
  const rutas = [...new Set(menu.map((m) => m.ruta))];
  return (
    <ProveedorTiempoReal>
      <ProveedorTelefono>
        <Routes>
          <Route element={<Marco />}>
            {rutas.map((r) => {
              const Pagina = PAGINAS[r];
              return Pagina ? <Route key={r} path={r} element={<Pagina />} /> : null;
            })}
            {rutas.includes('/campanas') && <Route path="/campanas/:id" element={<CampanaDetalle />} />}
            <Route path="*" element={<Navigate to={inicio} replace />} />
          </Route>
        </Routes>
      </ProveedorTelefono>
    </ProveedorTiempoReal>
  );
}

createRoot(document.getElementById('raiz')!).render(
  <StrictMode>
    <BrowserRouter>
      <ProveedorSesion>
        <Aplicacion />
      </ProveedorSesion>
    </BrowserRouter>
  </StrictMode>,
);
