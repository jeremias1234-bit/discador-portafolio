-- 005: IVR con aviso al vendedor (2026-11-02).
--   El cliente escucha el mensaje ("si te interesa marcá 1 para que te llamemos o 2 para que te
--   escribamos por WhatsApp") y al marcar se corta la llamada: el número llega como aviso a un
--   vendedor, por turno (1, 2, 3, 1, 2…), en la extensión de Chrome y en el panel.
--   - campanas.ivr_destino: 'vendedor' (pasa la llamada, como hasta ahora) o 'aviso'.
--   - Teclas de llamada y de WhatsApp (una de las dos puede quedar sin usar) y un audio opcional
--     de despedida que se pasa después de marcar.
--   - Permiso 'ivr.avisos': ver los avisos de todos los vendedores (el vendedor ve los suyos).

ALTER TABLE campanas
  ADD COLUMN ivr_destino TEXT NOT NULL DEFAULT 'vendedor' CHECK (ivr_destino IN ('vendedor', 'aviso')),
  ADD COLUMN ivr_tecla_llamada CHAR(1) DEFAULT '1' CHECK (ivr_tecla_llamada ~ '^[0-9*#]$'),
  ADD COLUMN ivr_tecla_whatsapp CHAR(1) DEFAULT '2' CHECK (ivr_tecla_whatsapp ~ '^[0-9*#]$'),
  ADD COLUMN ivr_audio_despedida_id INT REFERENCES audios(id) ON DELETE SET NULL,
  ADD CONSTRAINT campanas_teclas_aviso_distintas CHECK (
    ivr_tecla_llamada IS DISTINCT FROM ivr_tecla_whatsapp
    AND ivr_tecla_no_llame IS DISTINCT FROM ivr_tecla_llamada
    AND ivr_tecla_no_llame IS DISTINCT FROM ivr_tecla_whatsapp),
  ADD CONSTRAINT campanas_aviso_con_tecla CHECK (
    ivr_destino <> 'aviso' OR ivr_tecla_llamada IS NOT NULL OR ivr_tecla_whatsapp IS NOT NULL);

ALTER TABLE llamadas DROP CONSTRAINT llamadas_resultado_check;
ALTER TABLE llamadas ADD CONSTRAINT llamadas_resultado_check CHECK (resultado IN
  ('no_contesta', 'ocupado', 'fallida', 'contestador', 'atendida', 'abandonada', 'corto_en_mensaje',
   'sin_confirmar', 'no_llame_ivr', 'no_llame', 'fuera_de_horario',
   'aviso_ivr')); -- marcó la tecla de llamada o de WhatsApp: quedó como aviso para un vendedor

CREATE TABLE avisos_ivr (
  id           BIGSERIAL PRIMARY KEY,
  llamada_id   BIGINT REFERENCES llamadas(id) ON DELETE SET NULL,
  campana_id   INT REFERENCES campanas(id) ON DELETE SET NULL,
  lead_id      BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  telefono     TEXT NOT NULL,
  nombre       TEXT,
  contacto     TEXT NOT NULL CHECK (contacto IN ('llamada', 'whatsapp')),
  tecla        CHAR(1) NOT NULL,
  vendedor_id  INT REFERENCES usuarios(id) ON DELETE SET NULL,  -- NULL = no había vendedor para asignar
  estado       TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'contactado', 'descartado')),
  visto_en     TIMESTAMPTZ,
  cerrado_en   TIMESTAMPTZ,
  notas        TEXT,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_avisos_vendedor ON avisos_ivr (vendedor_id, creado_en DESC);
CREATE INDEX idx_avisos_campana ON avisos_ivr (campana_id, id DESC);
CREATE INDEX idx_avisos_pendientes ON avisos_ivr (creado_en) WHERE estado = 'pendiente';

INSERT INTO permisos (codigo, area, descripcion, orden) VALUES
  ('ivr.avisos', 'IVR', 'Ver los avisos del IVR de todos los vendedores', 44);
INSERT INTO rol_permisos (rol, permiso) VALUES
  ('admin', 'ivr.avisos'),
  ('supervisor', 'ivr.avisos');
