// Nivel de rendimiento: cuántas llamadas por hora hace todo el sistema (ritmo.limite_por_minuto).
// Cada nivel tiene su riesgo: muchas llamadas por SIM y por hora hacen que las operadoras
// marquen los números como spam o bloqueen las SIM.
import { api } from '../api';
import { MensajeError, numero, useAccion, useDatos } from './ui';

export const NIVELES = [
  {
    clave: 'lento', nombre: 'Lento / cuidadoso', porHora: 2500,
    descripcion: 'Riesgo de bloqueo de SIM mínimo. Para SIM nuevas o recién recargadas, o cuando una operadora viene bloqueando. Los vendedores esperan más entre llamadas.',
  },
  {
    clave: 'normal', nombre: 'Normal', porHora: 4500,
    descripcion: 'El equilibrio recomendado para el día a día (~50.000 intentos por jornada). Riesgo bajo si las llamadas se reparten entre todos los gateways.',
  },
  {
    clave: 'intensivo', nombre: 'Intensivo', porHora: 6000,
    descripcion: 'Más contactos por hora. Las operadoras empiezan a detectar SIM con muchas llamadas cortas: vigilar la contestación por gateway en el monitor; si cae, bajar de nivel.',
  },
  {
    clave: 'riesgoso', nombre: 'Riesgoso', porHora: 8000,
    descripcion: 'Ritmo máximo. Riesgo alto de que las SIM se bloqueen o los números salgan marcados como spam. Solo por ratos cortos y con todas las SIM en uso.',
  },
] as const;

/** Llamadas por minuto que se guardan para cada nivel (el motor controla por minuto). */
const porMinuto = (porHora: number) => Math.round(porHora / 60);

export function nivelActual(limitePorMinuto: number | undefined) {
  return NIVELES.find((n) => porMinuto(n.porHora) === limitePorMinuto) ?? null;
}

export function Rendimiento({ editable }: { editable: boolean }) {
  const { datos: config, recargar } = useDatos<{ clave: string; valor: unknown }[]>('/api/configuracion');
  const { datos: gateways } = useDatos<{ canales: number; activo: boolean }[]>('/api/gateways');
  const { ocupado, error, ejecutar } = useAccion();
  const limite = config?.find((p) => p.clave === 'ritmo.limite_por_minuto')?.valor as number | undefined;
  const actual = nivelActual(limite);
  const sims = (gateways ?? []).filter((g) => g.activo).reduce((t, g) => t + g.canales, 0);

  const elegir = async (n: (typeof NIVELES)[number]) => {
    if (n.clave === 'riesgoso' && !confirm('El nivel riesgoso puede hacer que se bloqueen SIM. ¿Activarlo igual?')) return;
    if (await ejecutar(() => api.patch('/api/configuracion', { 'ritmo.limite_por_minuto': porMinuto(n.porHora) }))) void recargar();
  };

  return (
    <section className="tarjeta">
      <div className="fila separada">
        <h2>Rendimiento</h2>
        <span className="suave chico">
          {actual ? `Nivel actual: ${actual.nombre}` : limite ? `Personalizado: ${numero(limite * 60)} llamadas por hora` : ''}
        </span>
      </div>
      <div className="niveles">
        {NIVELES.map((n) => {
          const elegido = actual?.clave === n.clave;
          return (
            <button key={n.clave} type="button" className={`nivel ${elegido ? 'elegido' : ''} nivel-${n.clave}`} onClick={() => void elegir(n)} disabled={!editable || ocupado || elegido}>
              <strong>{n.nombre}</strong>
              <span className="numero">{numero(n.porHora)} llamadas/h</span>
              <small>{n.descripcion}</small>
              {sims > 0 && <small className="numero">≈ {Math.round(n.porHora / sims)} llamadas por SIM por hora con {sims} SIM</small>}
            </button>
          );
        })}
      </div>
      <MensajeError mensaje={error} />
    </section>
  );
}
