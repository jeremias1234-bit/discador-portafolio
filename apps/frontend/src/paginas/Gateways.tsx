// Gateways (§3, §16): alta, canales, reservados para manual, ritmo y encendido.
// Al guardar, el backend regenera la configuración de Asterisk y la recarga.
import { Catalogo, type DefCampo } from '../componentes/Catalogo';
import { Encabezado } from '../componentes/ui';
import { useSesion } from '../sesion';

interface Gateway {
  id: number;
  nombre: string;
  endpoint_pjsip: string;
  ip: string | null;
  canales: number;
  canales_reservados_manual: number;
  llamadas_por_segundo: number | null;
  orden: number;
  activo: boolean;
}

const CAMPOS: DefCampo<Gateway>[] = [
  { clave: 'nombre', etiqueta: 'Nombre', tipo: 'texto', requerido: true },
  { clave: 'endpoint_pjsip', etiqueta: 'Identificador en Asterisk', tipo: 'texto', requerido: true, ayuda: 'Letras, números, _ o -. Ej.: dinstar_11.' },
  { clave: 'ip', etiqueta: 'IP', tipo: 'texto', nulo: true, ayuda: 'IP fija del Dinstar en la LAN. Sin IP no se usa.' },
  { clave: 'canales', etiqueta: 'Canales', tipo: 'numero', requerido: true, min: 1, max: 512, ayuda: 'Cantidad de SIM / puertos.' },
  { clave: 'canales_reservados_manual', etiqueta: 'Reservados para manual', tipo: 'numero', min: 0, max: 512, porDefecto: 0, ayuda: 'El discador no los usa: quedan para llamadas manuales.' },
  { clave: 'llamadas_por_segundo', etiqueta: 'Llamadas por segundo', tipo: 'numero', nulo: true, min: 0.1, max: 100, paso: 0.1, ayuda: 'Máximo de llamadas nuevas por segundo. Vacío = sin límite.' },
  { clave: 'orden', etiqueta: 'Orden', tipo: 'numero', min: 0, max: 1000, porDefecto: 0, ayuda: 'Se usan primero los de menor orden.' },
  { clave: 'activo', etiqueta: 'Activo', tipo: 'si_no', porDefecto: true, ayuda: 'Apagado = no sale ninguna llamada por este gateway.', mostrar: (g) => (g.activo ? <span className="chip ok">Activo</span> : <span className="chip">Apagado</span>) },
];

export function Gateways() {
  const { puede } = useSesion();
  return (
    <>
      <Encabezado titulo="Gateways" />
      <Catalogo<Gateway>
        ruta="/api/gateways" campos={CAMPOS} singular="gateway" columnaActivo="activo" editable={puede('gateways.editar')}
        nota={<div className="alerta info">En el Dinstar: SIP Trunk por IP hacia este servidor, con KeepAlive. Los cambios se aplican en Asterisk al guardar, sin reiniciar.</div>}
      />
    </>
  );
}
