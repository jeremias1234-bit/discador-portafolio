-- 008: Leads del bot de WhatsApp (2026-11-08).
--   Una extensión de Chrome en la PC donde corre el bot (TURBO BOT sobre WhatsApp Web) mira los
--   chats en solo lectura y, cuando el cliente responde el pedido de DNI (portabilidad) o el de
--   domicilio (fibra), manda el contacto al discador. Entra al mismo sistema de avisos que el IVR
--   pero como otra cola:
--   - avisos_ivr.origen: 'ivr' (marcó una tecla en el IVR) o 'whatsapp' (lead del bot). Los del bot
--     no tienen llamada ni tecla, y traen DNI, compañía, interés y dirección.
--   - Turno propio: los leads se reparten entre los usuarios con usuarios.recibe_leads (no dependen
--     de una campaña), así nunca le "roban" el turno a los avisos del IVR ni al revés.
--   - tokens_servicio: claves para programas (no personas). El Detector usa una con alcance
--     'leads': solo puede cargar leads, mandar su latido y leer los textos disparadores.

ALTER TABLE avisos_ivr
  ADD COLUMN origen TEXT NOT NULL DEFAULT 'ivr' CHECK (origen IN ('ivr', 'whatsapp')),
  ALTER COLUMN tecla DROP NOT NULL,
  ADD CONSTRAINT avisos_ivr_tecla_del_ivr CHECK (origen <> 'ivr' OR tecla IS NOT NULL),
  ADD COLUMN dni TEXT CHECK (dni ~ '^\d{7,8}$'),
  ADD COLUMN dni_texto TEXT,                     -- lo que escribió el cliente cuando se le pidió el DNI
  ADD COLUMN compania TEXT,                      -- la que eligió en el menú del bot (Claro, Personal...)
  ADD COLUMN interes TEXT CHECK (interes IN ('portabilidad', 'fibra')),
  ADD COLUMN direccion TEXT,                     -- fibra: la respuesta al pedido de domicilio, tal cual
  ADD COLUMN chat_hora TIMESTAMPTZ,              -- cuándo respondió el cliente en WhatsApp
  ADD COLUMN pc_bot TEXT,                        -- nombre de la PC del Detector que lo mandó
  ADD COLUMN actualizado_en TIMESTAMPTZ;         -- el Detector completó un dato (DNI o dirección) después
CREATE INDEX idx_avisos_origen_telefono ON avisos_ivr (origen, telefono, creado_en DESC);

-- Quién recibe leads del bot: arranca igual que "Recibe IVR" en los vendedores
ALTER TABLE usuarios ADD COLUMN recibe_leads BOOLEAN NOT NULL DEFAULT false;
UPDATE usuarios SET recibe_leads = recibe_ivr WHERE rol = 'vendedor';

CREATE TABLE tokens_servicio (
  id             SERIAL PRIMARY KEY,
  nombre         TEXT NOT NULL,                  -- ej. "Detector PC del bot"
  alcance        TEXT NOT NULL CHECK (alcance IN ('leads')),
  hash           TEXT NOT NULL UNIQUE,           -- sha256 del token: el token en claro se muestra una sola vez
  creado_por     INT REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revocado_en    TIMESTAMPTZ,
  ultimo_uso_en  TIMESTAMPTZ,
  ultimo_ip      TEXT
);

-- Textos que disparan un lead (se comparan en minúsculas, sin acentos, emojis ni signos: basta
-- con que el mensaje del bot contenga alguno). El Detector los toma del panel.
INSERT INTO configuracion (clave, valor) VALUES
  ('leads.disparadores_portabilidad', '["numero de dni del titular"]'),
  ('leads.disparadores_fibra', '["donde deseas instalar el servicio", "donde quiere instalar el servicio", "domicilio donde quiere instalar"]'),
  ('leads.horas_deduplicacion', '24'),
  ('leads.antiguedad_max_min', '10');

INSERT INTO permisos (codigo, area, descripcion, orden) VALUES
  ('leads.ver', 'Leads', 'Ver los leads del bot de WhatsApp de todos los vendedores', 45),
  ('leads.editar', 'Leads', 'Configurar el Detector de leads y sus tokens', 46);
INSERT INTO rol_permisos (rol, permiso) VALUES
  ('admin', 'leads.ver'),
  ('admin', 'leads.editar'),
  ('supervisor', 'leads.ver');
