-- 007: dos audios en la misma campaña, para compararlos (2026-11-03).
--   - campanas.audio_b_id: segundo audio (opcional). campanas.audio_id sigue siendo el audio A.
--     Como el A, no se puede borrar un audio que una campaña usa como B (RESTRICT).
--   - campanas.audio_b_pct: qué parte de las llamadas escucha el B (30 = de cada 10, 3 con el B y
--     7 con el A). Se reparte alternando parejo, no al azar, para que los dos caigan en las mismas
--     horas y la misma base. Se cambia en caliente.
--   - llamadas.audio_id: el audio que escuchó la llamada (NULL = no llegó al mensaje). Las llamadas
--     anteriores a esta migración quedan sin dato: la comparación cuenta desde acá.

ALTER TABLE campanas
  ADD COLUMN audio_b_id INT REFERENCES audios(id) ON DELETE RESTRICT,
  ADD COLUMN audio_b_pct SMALLINT NOT NULL DEFAULT 50 CHECK (audio_b_pct BETWEEN 0 AND 100),
  ADD CONSTRAINT campanas_audios_distintos CHECK (audio_b_id IS NULL OR audio_b_id <> audio_id);

ALTER TABLE llamadas ADD COLUMN audio_id INT REFERENCES audios(id) ON DELETE SET NULL;
CREATE INDEX idx_llamadas_campana_audio ON llamadas (campana_id, audio_id) WHERE audio_id IS NOT NULL;
