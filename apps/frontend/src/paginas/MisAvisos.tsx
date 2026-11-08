// Avisos del vendedor, los mismos que le llegan a la extensión de Chrome, en dos pestañas
// separadas: LEADS (clientes que le respondieron al bot de WhatsApp) e IVR (marcaron en el mensaje).
import { useEffect, useState } from 'react';
import { TablaAvisos, type Aviso } from '../componentes/Avisos';
import { Encabezado, MensajeError, Pestanas, useDatos } from '../componentes/ui';
import { useSesion } from '../sesion';
import { useTiempoReal } from '../tiempoReal';

type Origen = 'whatsapp' | 'ivr';

export function MisAvisos() {
  const { yo } = useSesion();
  const { suscribir } = useTiempoReal();
  const { datos, error, recargar } = useDatos<{ pendientes: Aviso[]; recientes: Aviso[] }>('/api/avisos/mios');
  const [origen, setOrigen] = useState<Origen>(yo?.recibe_leads || !yo?.recibe_ivr ? 'whatsapp' : 'ivr');

  useEffect(() => suscribir('avisos', () => void recargar()), [suscribir, recargar]);

  const de = (lista: Aviso[] | undefined) => (lista ?? []).filter((a) => (a.origen ?? 'ivr') === origen);
  const pendientesDe = (o: Origen) => (datos?.pendientes ?? []).filter((a) => (a.origen ?? 'ivr') === o).length;
  const esLead = origen === 'whatsapp';

  return (
    <>
      <Encabezado titulo="Mis avisos">
        <a className="boton" href="/api/extension.zip"><button>Descargar extensión de Chrome</button></a>
      </Encabezado>
      <Pestanas<Origen>
        opciones={[['whatsapp', `LEADS (${pendientesDe('whatsapp')})`], ['ivr', `IVR (${pendientesDe('ivr')})`]]}
        actual={origen}
        onCambiar={setOrigen}
      />
      <div className="suave" style={{ marginBottom: 12 }}>
        {esLead
          ? 'Clientes que le respondieron al bot de WhatsApp (DNI para portabilidad, domicilio para fibra). Te llegan por turno: escribiles cuanto antes.'
          : 'Clientes que escucharon el mensaje y marcaron que los llamen o les escriban por WhatsApp. Te llegan por turno.'}
      </div>
      <MensajeError mensaje={error} />
      <div className="pila" style={{ gap: 14 }}>
        <section className="panel">
          <h2 className="panel-titulo">Pendientes ({de(datos?.pendientes).length})</h2>
          <TablaAvisos avisos={de(datos?.pendientes)} leads={esLead} onCambio={() => void recargar()} />
        </section>
        <section className="panel">
          <h2 className="panel-titulo">Últimos cerrados</h2>
          <TablaAvisos avisos={de(datos?.recientes)} leads={esLead} onCambio={() => void recargar()} />
        </section>
      </div>
    </>
  );
}
