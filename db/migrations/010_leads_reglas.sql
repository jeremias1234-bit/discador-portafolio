-- 010: reglas de reparto de los leads del bot de WhatsApp (2026-11-08).
--   Los leads llegan a toda hora, también fuera del horario de trabajo, así que quién los recibe
--   se decide con reglas por día y horario, armadas desde la sección Leads (aparte del IVR):
--   - cada regla tiene días, horario (puede cruzar la medianoche), vendedores y modo:
--       'conectadas': por turno solo entre las de la regla que tienen la extensión o el panel
--                     abiertos (si no hay ninguna conectada, entre todas las de la regla);
--       'todas':      por turno entre todas las de la regla, estén conectadas o no (el lead las
--                     espera en la extensión). Sirve para fuera de horario.
--   - si dos reglas coinciden, gana la de menor `orden` (la de más arriba en el panel);
--   - la regla por defecto (sin horario) se usa cuando no aplica ninguna otra. Arranca con los
--     que hoy tienen "Recibe leads"; desde ahora usuarios.recibe_leads ya no decide el reparto.
--   Días: 1 = lunes … 7 = domingo.

CREATE TABLE leads_reglas (
  id           SERIAL PRIMARY KEY,
  nombre       TEXT NOT NULL,
  por_defecto  BOOLEAN NOT NULL DEFAULT false,
  dias         SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  desde        TIME,
  hasta        TIME,
  modo         TEXT NOT NULL DEFAULT 'conectadas' CHECK (modo IN ('conectadas', 'todas')),
  activa       BOOLEAN NOT NULL DEFAULT true,
  orden        INT NOT NULL DEFAULT 0,
  creada_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leads_reglas_horario CHECK (por_defecto OR (desde IS NOT NULL AND hasta IS NOT NULL AND desde <> hasta)),
  CONSTRAINT leads_reglas_dias CHECK (cardinality(dias) > 0 AND dias <@ '{1,2,3,4,5,6,7}'::smallint[])
);
CREATE UNIQUE INDEX leads_reglas_una_por_defecto ON leads_reglas (por_defecto) WHERE por_defecto;

CREATE TABLE leads_regla_vendedores (
  regla_id    INT NOT NULL REFERENCES leads_reglas(id) ON DELETE CASCADE,
  usuario_id  INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  PRIMARY KEY (regla_id, usuario_id)
);

INSERT INTO leads_reglas (nombre, por_defecto, modo, orden)
  VALUES ('Por defecto (cuando no aplica otra regla)', true, 'conectadas', 1000);
INSERT INTO leads_regla_vendedores (regla_id, usuario_id)
  SELECT r.id, u.id FROM leads_reglas r, usuarios u
   WHERE r.por_defecto AND u.recibe_leads AND u.activo AND u.rol = 'vendedor';
