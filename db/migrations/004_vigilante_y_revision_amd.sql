-- 004: vigilante de canales, grabación de la detección de contestador y revisión del AMD (2026-10-27).
--   - Cada llamada atendida graba los segundos de la detección (amd-<id>.wav) para poder escuchar
--     si el AMD acertó; la revisión queda en la llamada.
--   - La tipificación "Contestador" (es_contestador) marca que el AMD dejó pasar una máquina.
--   - Duración máxima de una llamada: el vigilante corta lo que la supere.

ALTER TABLE llamadas
  ADD COLUMN amd_grabacion_path TEXT,
  ADD COLUMN amd_revision TEXT CHECK (amd_revision IN ('acerto', 'error')),
  ADD COLUMN amd_revisado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN amd_revisado_en TIMESTAMPTZ;
CREATE INDEX idx_llamadas_amd ON llamadas (inicio) WHERE amd_estado IS NOT NULL;

ALTER TABLE tipificaciones ADD COLUMN es_contestador BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tipificaciones ADD CONSTRAINT tipificaciones_contestador_no_venta CHECK (NOT (es_contestador AND es_venta));
INSERT INTO tipificaciones (nombre, es_final, es_venta, es_contestador, orden)
VALUES ('Contestador', false, false, true, 0)
ON CONFLICT (nombre) DO UPDATE SET es_contestador = true, es_venta = false;

INSERT INTO configuracion (clave, valor) VALUES
  ('amd.grabar_deteccion', 'true'),
  ('llamadas.duracion_max_min', '60');
