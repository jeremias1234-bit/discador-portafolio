-- 001: esquema inicial del discador (funciones principales del discador)
-- El runner (npm run migrar) ejecuta cada archivo dentro de una transacción.
--
-- Convenciones:
--   * Teléfonos normalizados a dígitos nacionales, sin 0 ni 15 (ej. 2617256360).
--   * Baja lógica: lo que tiene historia (usuarios, campañas, gateways) no se borra, se desactiva.
--   * Los parámetros globales viven en `configuracion`; los de cada campaña, en `campanas`.

-- =====================================================================
--  Usuarios, sedes y permisos (§2, §14)
-- =====================================================================

CREATE TABLE sedes (
  id        SERIAL PRIMARY KEY,
  nombre    TEXT NOT NULL UNIQUE,
  activa    BOOLEAN NOT NULL DEFAULT true,
  creada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vendedores, supervisores y admins
CREATE TABLE usuarios (
  id                  SERIAL PRIMARY KEY,
  nombre              TEXT NOT NULL,
  usuario             TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  rol                 TEXT NOT NULL CHECK (rol IN ('vendedor', 'supervisor', 'admin')),
  sede_id             INT REFERENCES sedes(id) ON DELETE SET NULL,
  -- Interno SIP: el softphone del vendedor o, en supervisores, el del navegador para escuchar/intervenir
  interno_sip         TEXT UNIQUE,
  clave_sip           TEXT,                       -- la usa Asterisk y se entrega al softphone del navegador
  tipo_telefono       TEXT NOT NULL DEFAULT 'navegador' CHECK (tipo_telefono IN ('navegador', 'externo')),
  -- Solo vendedores
  puede_marcar_manual BOOLEAN NOT NULL DEFAULT false,
  recibe_ivr          BOOLEAN NOT NULL DEFAULT true,  -- recibe derivaciones del IVR
  tope_llamadas       NUMERIC(4,2) CHECK (tope_llamadas > 0),  -- llamadas en el aire por vendedor libre; NULL = global
  -- Estado
  activo              BOOLEAN NOT NULL DEFAULT true,
  baja_en             TIMESTAMPTZ,
  ultimo_acceso       TIMESTAMPTZ,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (activo OR baja_en IS NOT NULL)
);

-- Catálogo fijo de permisos; lo carga esta migración
CREATE TABLE permisos (
  codigo      TEXT PRIMARY KEY,               -- ej. 'campanas.editar'
  area        TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  orden       INT NOT NULL
);

-- Permisos que trae cada rol por defecto
CREATE TABLE rol_permisos (
  rol     TEXT NOT NULL CHECK (rol IN ('vendedor', 'supervisor', 'admin')),
  permiso TEXT NOT NULL REFERENCES permisos(codigo) ON DELETE CASCADE,
  PRIMARY KEY (rol, permiso)
);

-- Excepciones por usuario: concedido = true agrega, false quita.
-- Permiso efectivo = permisos del rol + concedidos - quitados.
CREATE TABLE usuario_permisos (
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  permiso    TEXT NOT NULL REFERENCES permisos(codigo) ON DELETE CASCADE,
  concedido  BOOLEAN NOT NULL,
  PRIMARY KEY (usuario_id, permiso)
);

-- =====================================================================
--  Configuración global (§13, §16): todo parámetro editable desde el panel
-- =====================================================================

-- Clave/valor tipado en el backend (zod). Los valores por defecto se cargan al final.
CREATE TABLE configuracion (
  clave           TEXT PRIMARY KEY,           -- ej. 'amd.silencio_inicial_ms'
  valor           JSONB NOT NULL,
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por INT REFERENCES usuarios(id) ON DELETE SET NULL
);

-- =====================================================================
--  Gateways y canales (§3)
-- =====================================================================

CREATE TABLE gateways (
  id                 SERIAL PRIMARY KEY,
  nombre             TEXT NOT NULL UNIQUE,
  endpoint_pjsip     TEXT NOT NULL UNIQUE,      -- nombre del endpoint en pjsip.conf
  ip                 INET,
  canales            INT NOT NULL CHECK (canales > 0),
  -- Canales que el discador no puede ocupar, para que siempre se pueda marcar a mano.
  -- Reservar un gateway entero = canales_reservados_manual igual a canales.
  canales_reservados_manual INT NOT NULL DEFAULT 0,
  llamadas_por_segundo NUMERIC(4,1) CHECK (llamadas_por_segundo > 0),  -- NULL = sin límite (P1)
  orden              INT NOT NULL DEFAULT 1,    -- menor = se usa primero
  activo             BOOLEAN NOT NULL DEFAULT true,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (canales_reservados_manual BETWEEN 0 AND canales)
);

-- =====================================================================
--  Audios, tipificación y descansos (§1, §9, §13)
-- =====================================================================

CREATE TABLE audios (
  id           SERIAL PRIMARY KEY,
  nombre       TEXT NOT NULL,
  archivo      TEXT NOT NULL UNIQUE,          -- en sounds/campanas/, sin extensión
  duracion_seg NUMERIC(6,2),
  subido_por   INT REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Catálogo global de tipificaciones
CREATE TABLE tipificaciones (
  id                SERIAL PRIMARY KEY,
  nombre            TEXT NOT NULL UNIQUE,
  es_final          BOOLEAN NOT NULL DEFAULT true,   -- false = el lead vuelve a la cola
  es_venta          BOOLEAN NOT NULL DEFAULT false,
  reintentar_en_min INT CHECK (reintentar_en_min > 0), -- solo si no es final; NULL = minutos de la campaña
  marca_no_llame    BOOLEAN NOT NULL DEFAULT false,  -- el vendedor manda el número a No Llame
  orden             INT NOT NULL DEFAULT 0,
  activa            BOOLEAN NOT NULL DEFAULT true,
  CHECK (es_final OR NOT es_venta),
  CHECK (NOT es_final OR reintentar_en_min IS NULL)
);

CREATE TABLE motivos_descanso (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL UNIQUE,
  max_minutos INT CHECK (max_minutos > 0),     -- aviso al superarlo; NULL = sin tope
  orden       INT NOT NULL DEFAULT 0,
  visible     BOOLEAN NOT NULL DEFAULT true,   -- lo puede elegir el vendedor
  activo      BOOLEAN NOT NULL DEFAULT true
);

-- =====================================================================
--  Campañas (§1, §2, §3, §7)
-- =====================================================================

CREATE TABLE campanas (
  id                    SERIAL PRIMARY KEY,
  nombre                TEXT NOT NULL,
  tipo                  TEXT NOT NULL CHECK (tipo IN
                        ('manual', 'progresivo', 'predictivo', 'predictivo_audio', 'ivr')),
  estado                TEXT NOT NULL DEFAULT 'pausada' CHECK (estado IN
                        ('activa', 'pausada', 'terminada', 'archivada')),
  prioridad             INT NOT NULL DEFAULT 0,          -- mayor = se atiende primero
  -- Horario propio: solo restringe dentro del horario global
  hora_inicio           TIME NOT NULL DEFAULT '10:00',
  hora_fin              TIME NOT NULL DEFAULT '21:00',
  dias_semana           SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',  -- ISO: 1 = lunes ... 7 = domingo
  -- Reintentos
  max_intentos          INT NOT NULL DEFAULT 3 CHECK (max_intentos > 0),
  minutos_reintento     INT NOT NULL DEFAULT 60 CHECK (minutos_reintento > 0),
  segundos_timbre       INT NOT NULL DEFAULT 30 CHECK (segundos_timbre > 0),
  -- Canales
  todos_los_gateways    BOOLEAN NOT NULL DEFAULT true,   -- false = solo los de campana_gateways
  tope_canales          INT CHECK (tope_canales > 0),    -- NULL = sin tope propio
  -- Ritmo (progresivo/predictivo); NULL = valor global de configuracion
  llamadas_por_vendedor NUMERIC(4,2) CHECK (llamadas_por_vendedor > 0),
  abandono_objetivo_pct NUMERIC(4,2) CHECK (abandono_objetivo_pct >= 0),
  -- Detección y grabación
  amd_activo            BOOLEAN NOT NULL DEFAULT true,
  grabar                BOOLEAN NOT NULL DEFAULT true,
  -- Audio inicial y pase al vendedor (predictivo_audio e ivr)
  audio_id              INT REFERENCES audios(id) ON DELETE RESTRICT,
  ivr_modo              TEXT NOT NULL DEFAULT 'permanencia' CHECK (ivr_modo IN
                        ('presione_1', 'permanencia', 'cualquiera')),
  ivr_tecla_pase        CHAR(1) NOT NULL DEFAULT '1' CHECK (ivr_tecla_pase ~ '^[0-9*#]$'),
  ivr_tecla_no_llame    CHAR(1) CHECK (ivr_tecla_no_llame ~ '^[0-9*#]$'),  -- NULL = sin tecla
  ivr_espera_seg        INT NOT NULL DEFAULT 4 CHECK (ivr_espera_seg >= 0),
  ivr_repeticiones      INT NOT NULL DEFAULT 1 CHECK (ivr_repeticiones >= 1),
  espera_max_seg        INT NOT NULL DEFAULT 20 CHECK (espera_max_seg >= 0),  -- en cola sin vendedor
  ivr_canales           INT CHECK (ivr_canales > 0),    -- canales propios del IVR (P1); NULL = compartidos
  llamadas_por_segundo  NUMERIC(4,1) CHECK (llamadas_por_segundo > 0),
  creada_por            INT REFERENCES usuarios(id) ON DELETE SET NULL,
  creada_en             TIMESTAMPTZ NOT NULL DEFAULT now(),
  archivada_en          TIMESTAMPTZ,
  CHECK (ivr_tecla_no_llame IS DISTINCT FROM ivr_tecla_pase),
  CHECK (dias_semana <@ '{1,2,3,4,5,6,7}'::SMALLINT[] AND cardinality(dias_semana) > 0),
  CHECK (hora_inicio < hora_fin)
);

-- Vendedores asignados (el modo "todos atienden todas" es global: configuracion)
CREATE TABLE campana_vendedores (
  campana_id INT NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  PRIMARY KEY (campana_id, usuario_id)
);
CREATE INDEX idx_campana_vendedores_usuario ON campana_vendedores (usuario_id);

-- Gateways permitidos cuando campanas.todos_los_gateways = false
CREATE TABLE campana_gateways (
  campana_id INT NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  gateway_id INT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  PRIMARY KEY (campana_id, gateway_id)
);

-- =====================================================================
--  Bases y leads (§6)
-- =====================================================================

CREATE TABLE listas (
  id                      SERIAL PRIMARY KEY,
  campana_id              INT NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  nombre                  TEXT NOT NULL,
  archivo_origen          TEXT,
  columnas                JSONB NOT NULL DEFAULT '{}',  -- mapeo del CSV: cuál es el teléfono, el nombre, etc.
  estado                  TEXT NOT NULL DEFAULT 'cargando' CHECK (estado IN ('cargando', 'lista', 'error')),
  error                   TEXT,
  activa                  BOOLEAN NOT NULL DEFAULT true,  -- false = sus leads no se marcan
  -- Resultado de la carga
  filas_archivo           INT NOT NULL DEFAULT 0,
  cargados                INT NOT NULL DEFAULT 0,
  descartados_no_llame    INT NOT NULL DEFAULT 0,
  descartados_duplicados  INT NOT NULL DEFAULT 0,
  descartados_invalidos   INT NOT NULL DEFAULT 0,
  cargada_por             INT REFERENCES usuarios(id) ON DELETE SET NULL,
  cargada_en              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_listas_campana ON listas (campana_id);

CREATE TABLE leads (
  id               BIGSERIAL PRIMARY KEY,
  lista_id         INT NOT NULL REFERENCES listas(id) ON DELETE CASCADE,
  campana_id       INT NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  telefono         TEXT NOT NULL CHECK (telefono ~ '^[0-9]{6,15}$'),
  nombre           TEXT,
  datos            JSONB NOT NULL DEFAULT '{}',   -- columnas libres del CSV
  estado           TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN
                   ('pendiente',   -- nunca se llamó
                    'en_curso',    -- hay una llamada activa
                    'reintentar',  -- espera proximo_intento
                    'finalizado',  -- tipificado como final
                    'agotado',     -- llegó a max_intentos sin cierre
                    'no_llamar')), -- entró a No Llame después de cargado
  intentos         INT NOT NULL DEFAULT 0,
  ultimo_resultado TEXT,
  ultima_llamada_en TIMESTAMPTZ,
  proximo_intento  TIMESTAMPTZ NOT NULL DEFAULT now(),
  prioridad        INT NOT NULL DEFAULT 0
);
-- Deduplicación: un teléfono una sola vez por campaña
CREATE UNIQUE INDEX uq_leads_campana_telefono ON leads (campana_id, telefono);
-- Cola del motor: solo los leads marcables, en el orden en que se toman
CREATE INDEX idx_leads_cola ON leads (campana_id, prioridad DESC, proximo_intento)
  WHERE estado IN ('pendiente', 'reintentar');
CREATE INDEX idx_leads_lista_estado ON leads (lista_id, estado);
CREATE INDEX idx_leads_telefono ON leads (telefono);

-- =====================================================================
--  Horario global y bloqueos (§7)
-- =====================================================================

-- Horario semanal global: la última palabra. Sin filas para un día = ese día no se marca.
CREATE TABLE horario_global (
  id          SERIAL PRIMARY KEY,
  dia_semana  SMALLINT NOT NULL CHECK (dia_semana BETWEEN 1 AND 7),  -- ISO: 1 = lunes
  hora_inicio TIME NOT NULL,
  hora_fin    TIME NOT NULL,
  CHECK (hora_inicio < hora_fin)
);
CREATE INDEX idx_horario_global_dia ON horario_global (dia_semana);

-- Bloqueos: semanales ("domingos de 14 a 17") o de una fecha puntual. No cortan llamadas en curso.
CREATE TABLE bloqueos_horario (
  id          SERIAL PRIMARY KEY,
  tipo        TEXT NOT NULL CHECK (tipo IN ('semanal', 'fecha')),
  dia_semana  SMALLINT CHECK (dia_semana BETWEEN 1 AND 7),
  fecha       DATE,
  hora_inicio TIME,                           -- NULL en ambos = todo el día
  hora_fin    TIME,
  campana_id  INT REFERENCES campanas(id) ON DELETE CASCADE,  -- NULL = todas las campañas
  motivo      TEXT NOT NULL,
  activo      BOOLEAN NOT NULL DEFAULT true,
  creado_por  INT REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((tipo = 'semanal' AND dia_semana IS NOT NULL AND fecha IS NULL)
      OR (tipo = 'fecha' AND fecha IS NOT NULL AND dia_semana IS NULL)),
  CHECK ((hora_inicio IS NULL) = (hora_fin IS NULL)),
  CHECK (hora_inicio IS NULL OR hora_inicio < hora_fin)
);

-- =====================================================================
--  No Llame (§8)
-- =====================================================================

-- Padrón oficial (~2,3 M). Se reemplaza entero en cada importación:
-- COPY a no_llame_padron_nuevo, índice, y en una transacción
-- ALTER TABLE ... RENAME (actual -> _viejo, _nuevo -> actual); DROP del viejo.
-- Por eso ninguna vista ni FK apunta a esta tabla.
CREATE TABLE no_llame_padron (
  telefono TEXT PRIMARY KEY
);

-- Historial de importaciones del padrón: fecha de la última carga visible y alerta si está viejo
CREATE TABLE no_llame_importaciones (
  id            SERIAL PRIMARY KEY,
  archivo       TEXT NOT NULL,
  fecha_padron  DATE,                         -- fecha de publicación según el portal oficial
  registros     INT,
  estado        TEXT NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('en_curso', 'aplicada', 'error')),
  error         TEXT,
  importado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
  iniciada_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminada_en  TIMESTAMPTZ
);

-- Lista propia: números bloqueados por la empresa, para siempre
CREATE TABLE no_llame_propia (
  telefono   TEXT PRIMARY KEY CHECK (telefono ~ '^[0-9]{6,15}$'),
  fuente     TEXT NOT NULL CHECK (fuente IN ('manual', 'vendedor', 'ivr')),
  motivo     TEXT,
  usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  llamada_id BIGINT,                          -- llamada que lo originó (vendedor o tecla del IVR)
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
--  Llamadas, derivaciones y estados del vendedor (§9, §10, §12)
-- =====================================================================

-- Un registro por cada intento de llamada: base de todos los reportes
CREATE TABLE llamadas (
  id                    BIGSERIAL PRIMARY KEY,
  lead_id               BIGINT REFERENCES leads(id) ON DELETE SET NULL,  -- NULL en manuales sin lead
  campana_id            INT REFERENCES campanas(id) ON DELETE SET NULL,
  lista_id              INT REFERENCES listas(id) ON DELETE SET NULL,     -- para reportes por base
  gateway_id            INT REFERENCES gateways(id) ON DELETE SET NULL,
  -- RESTRICT: un vendedor con llamadas no se puede borrar, solo dar de baja
  vendedor_id           INT REFERENCES usuarios(id) ON DELETE RESTRICT,
  origen                TEXT NOT NULL CHECK (origen IN ('discador', 'manual', 'ivr')),
  tipo_campana          TEXT CHECK (tipo_campana IN
                        ('manual', 'progresivo', 'predictivo', 'predictivo_audio', 'ivr')),
  canal_id              TEXT UNIQUE,          -- id del canal ARI (= uniqueid de Asterisk)
  telefono              TEXT NOT NULL,
  -- Fases
  inicio                TIMESTAMPTZ NOT NULL DEFAULT now(),
  contestada_en         TIMESTAMPTZ,
  audio_fin_en          TIMESTAMPTZ,          -- terminó el audio inicial / pasó el filtro
  en_cola_en            TIMESTAMPTZ,          -- empezó a esperar vendedor
  conectada_vendedor_en TIMESTAMPTZ,
  fin                   TIMESTAMPTZ,
  -- Resultado técnico
  resultado             TEXT CHECK (resultado IN
                        ('no_contesta', 'ocupado', 'fallida', 'contestador', 'atendida',
                         'abandonada',       -- pasó el filtro y nadie la tomó a tiempo
                         'corto_en_mensaje', -- colgó durante el audio inicial
                         'sin_confirmar',    -- modo presione_1 y no marcó
                         'no_llame_ivr',     -- marcó la tecla de No Llame
                         'no_llame',         -- bloqueada al momento de marcar
                         'fuera_de_horario')),
  amd_estado            TEXT CHECK (amd_estado IN ('HUMAN', 'MACHINE', 'NOTSURE', 'HANGUP')),
  amd_causa             TEXT,                 -- ej. 'LONGGREETING-1500-1500' tal cual lo da AMD
  tecla_ivr             CHAR(1),
  causa_sip             INT,                  -- hangup cause de Asterisk
  colgo                 TEXT CHECK (colgo IN ('cliente', 'vendedor', 'sistema')),
  -- Gestión del vendedor
  tipificacion_id       INT REFERENCES tipificaciones(id) ON DELETE RESTRICT,
  tipificada_en         TIMESTAMPTZ,
  notas                 TEXT,
  grabacion_path        TEXT
);
CREATE INDEX idx_llamadas_inicio ON llamadas (inicio);
CREATE INDEX idx_llamadas_campana_inicio ON llamadas (campana_id, inicio);
CREATE INDEX idx_llamadas_vendedor_inicio ON llamadas (vendedor_id, inicio);
CREATE INDEX idx_llamadas_lead ON llamadas (lead_id);
CREATE INDEX idx_llamadas_telefono ON llamadas (telefono);
-- Pendientes de tipificar por vendedor
CREATE INDEX idx_llamadas_sin_tipificar ON llamadas (vendedor_id, inicio)
  WHERE conectada_vendedor_en IS NOT NULL AND tipificacion_id IS NULL;

ALTER TABLE no_llame_propia
  ADD CONSTRAINT no_llame_propia_llamada_fk FOREIGN KEY (llamada_id) REFERENCES llamadas(id) ON DELETE SET NULL;

-- Derivaciones del IVR: quien pasó el filtro y nadie atendió, con el motivo, para volver a llamarlo
CREATE TABLE derivaciones (
  id           BIGSERIAL PRIMARY KEY,
  llamada_id   BIGINT NOT NULL REFERENCES llamadas(id) ON DELETE CASCADE,
  campana_id   INT REFERENCES campanas(id) ON DELETE SET NULL,
  lead_id      BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  telefono     TEXT NOT NULL,
  motivo       TEXT NOT NULL CHECK (motivo IN ('sin_vendedor_libre', 'espera_vencida', 'corto_en_cola')),
  estado       TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'atendida', 'descartada')),
  atendida_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
  atendida_en  TIMESTAMPTZ,
  creada_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_derivaciones_pendientes ON derivaciones (creada_en) WHERE estado = 'pendiente';

-- Historial de estados del vendedor: productividad y descansos
CREATE TABLE vendedor_eventos (
  id         BIGSERIAL PRIMARY KEY,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  estado     TEXT NOT NULL CHECK (estado IN
             ('login', 'disponible', 'en_llamada', 'tipificando', 'descanso', 'logout')),
  motivo_descanso_id INT REFERENCES motivos_descanso(id) ON DELETE RESTRICT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((estado = 'descanso') = (motivo_descanso_id IS NOT NULL))
);
CREATE INDEX idx_vendedor_eventos_usuario_ts ON vendedor_eventos (usuario_id, ts);

-- =====================================================================
--  Bitácora (§13, §14)
-- =====================================================================

CREATE TABLE bitacora (
  id         BIGSERIAL PRIMARY KEY,
  usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
  accion     TEXT NOT NULL,                   -- ej. 'campana.editar', 'usuario.permisos'
  entidad    TEXT,                            -- ej. 'campanas'
  entidad_id TEXT,
  detalle    JSONB NOT NULL DEFAULT '{}',     -- antes/después de los campos cambiados
  ip         INET,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bitacora_ts ON bitacora (ts);
CREATE INDEX idx_bitacora_usuario_ts ON bitacora (usuario_id, ts);

-- =====================================================================
--  Datos iniciales
-- =====================================================================

INSERT INTO permisos (codigo, area, descripcion, orden) VALUES
  ('monitor.ver',               'Monitor',       'Ver el monitor',                         10),
  ('monitor.todas_sedes',       'Monitor',       'Ver el monitor de todas las sedes',      11),
  ('supervision.escuchar',      'Supervisión',   'Escuchar llamadas',                      20),
  ('supervision.susurrar',      'Supervisión',   'Susurrar al vendedor',                   21),
  ('supervision.intervenir',    'Supervisión',   'Intervenir llamadas',                    22),
  ('campanas.ver',              'Campañas',      'Ver campañas',                           30),
  ('campanas.editar',           'Campañas',      'Crear y editar campañas',                31),
  ('campanas.encender',         'Campañas',      'Encender y pausar campañas',             32),
  ('campanas.archivar',         'Campañas',      'Archivar campañas',                      33),
  ('campanas.cargar_bases',     'Campañas',      'Cargar bases',                           34),
  ('campanas.reciclar_bases',   'Campañas',      'Reciclar bases',                         35),
  ('ivr.ver',                   'IVR',           'Ver IVR',                                40),
  ('ivr.editar',                'IVR',           'Crear y editar campañas IVR',            41),
  ('ivr.audios',                'IVR',           'Subir audios',                           42),
  ('ivr.salidas',               'IVR',           'Editar salidas del IVR',                 43),
  ('vendedores.ver',            'Vendedores',    'Ver vendedores',                         50),
  ('vendedores.editar',         'Vendedores',    'Alta y edición de vendedores',           51),
  ('vendedores.asignar',        'Vendedores',    'Asignar campañas',                       52),
  ('vendedores.ivr',            'Vendedores',    'Habilitar IVR por vendedor',             53),
  ('vendedores.baja',           'Vendedores',    'Dar de baja vendedores',                 54),
  ('usuarios.administrar',      'Usuarios',      'Administrar supervisores y admins',      60),
  ('usuarios.permisos',         'Usuarios',      'Editar permisos',                        61),
  ('gateways.ver',              'Gateways',      'Ver estado de gateways',                 70),
  ('gateways.editar',           'Gateways',      'Alta, edición y apagado de gateways',    71),
  ('config.ritmo',              'Configuración', 'Ritmo de marcado',                       80),
  ('config.amd',                'Configuración', 'AMD',                                    81),
  ('config.tipificacion',       'Configuración', 'Tipificación',                           82),
  ('config.horario',            'Configuración', 'Horario y bloqueos',                     83),
  ('config.no_llame',           'Configuración', 'No Llame',                               84),
  ('config.grabaciones',        'Configuración', 'Grabaciones',                            85),
  ('config.descansos',          'Configuración', 'Descansos',                              86),
  ('config.sedes',              'Configuración', 'Sedes',                                  87),
  ('grabaciones.escuchar',      'Grabaciones',   'Escuchar grabaciones',                   90),
  ('grabaciones.descargar',     'Grabaciones',   'Descargar grabaciones',                  91),
  ('reportes.ver',              'Reportes',      'Ver reportes y contactabilidad',        100),
  ('reportes.exportar',         'Reportes',      'Exportar reportes a CSV',               101),
  ('bitacora.ver',              'Bitácora',      'Ver la bitácora',                       110);

-- Admin: todo (incluye lo del supervisor, bases, usuarios, IVR y configuración).
-- Supervisor: solo mirar: monitor (estados y espera entre llamadas de los vendedores),
-- acceso a las llamadas grabadas, contactabilidad y reportes. Lo demás se concede por usuario.
-- Vendedor: nada del panel (marcar a mano es usuarios.puede_marcar_manual).
INSERT INTO rol_permisos (rol, permiso)
  SELECT 'admin', codigo FROM permisos;
INSERT INTO rol_permisos (rol, permiso)
  SELECT 'supervisor', codigo FROM permisos WHERE codigo IN (
    'monitor.ver', 'grabaciones.escuchar', 'reportes.ver');

-- Gateways de ejemplo (se editan desde el panel).
INSERT INTO gateways (nombre, endpoint_pjsip, ip, canales, orden, activo) VALUES
  ('dinstar_10', 'dinstar_10', '192.168.1.35', 25, 1, true),
  ('dinstar_11', 'dinstar_11', NULL,           30, 2, false),
  ('dinstar_12', 'dinstar_12', NULL,           27, 3, false),
  ('dinstar_13', 'dinstar_13', NULL,           30, 4, false);

INSERT INTO tipificaciones (nombre, es_final, es_venta, reintentar_en_min, marca_no_llame, orden) VALUES
  ('Venta',            true,  true,  NULL, false, 10),
  ('No interesado',    true,  false, NULL, false, 20),
  ('Volver a llamar',  false, false, NULL, false, 30),
  ('Número equivocado',true,  false, NULL, false, 40),
  ('No llamar más',    true,  false, NULL, true,  50);

INSERT INTO motivos_descanso (nombre, orden) VALUES
  ('Baño', 10), ('Almuerzo', 20), ('Capacitación', 30), ('Reunión', 40);

-- Parámetros globales con sus valores por defecto (el backend los valida y los edita el panel)
INSERT INTO configuracion (clave, valor) VALUES
  -- General
  ('general.zona_horaria',              '"America/Argentina/Buenos_Aires"'),
  ('general.vendedor_solo_su_campana',  'true'),   -- false = todos atienden todas
  -- Ritmo de marcado
  ('ritmo.llamadas_por_vendedor',       '1.5'),
  ('ritmo.abandono_objetivo_pct',       '3'),
  ('ritmo.muestras_minimas',            '50'),
  ('ritmo.rafaga_por_ciclo',            '10'),
  ('ritmo.limite_por_minuto',           '300'),
  ('ritmo.adaptativo',                  'true'),
  ('ritmo.recuento_campanas_seg',       '2'),
  ('ritmo.aviso_llamada_larga_min',     '15'),
  ('ritmo.aviso_base_por_acabarse',     '500'),
  -- AMD (valores por defecto de Asterisk)
  ('amd.silencio_inicial_ms',           '2500'),
  ('amd.saludo_max_ms',                 '1500'),
  ('amd.silencio_tras_saludo_ms',       '800'),
  ('amd.tiempo_total_ms',               '5000'),
  ('amd.palabra_min_ms',                '100'),
  ('amd.silencio_entre_palabras_ms',    '50'),
  ('amd.palabras_maquina',              '2'),
  ('amd.umbral_silencio',               '256'),
  ('amd.palabra_max_ms',                '5000'),
  ('amd.pasar_dudosas',                 'true'),   -- NOTSURE va al vendedor
  -- IVR (globales)
  ('ivr.prioridad_en_cola',             'true'),   -- las derivaciones del IVR pasan antes que el discador
  -- Tipificación
  ('tipificacion.obligatoria',          'true'),
  ('tipificacion.pendientes_horas',     '24'),
  ('tipificacion.duracion_minima_seg',  '5'),
  -- Grabaciones
  ('grabaciones.retencion_dias',        '90'),
  ('grabaciones.piso_disco_libre_gb',   '20'),
  ('grabaciones.por_pagina',            '50'),
  -- No Llame
  ('no_llame.alerta_dias_padron',       '30'),     -- alerta si el padrón tiene más días que esto
  -- Teléfono del vendedor
  ('telefono.tono_entrada',             'true'),
  ('telefono.volumen_inicial',          '0.7');

-- Horario de la operación: lunes a viernes de 10 a 21 (sábados y domingos se agregan desde el panel)
INSERT INTO horario_global (dia_semana, hora_inicio, hora_fin)
  SELECT d, '10:00', '21:00' FROM generate_series(1, 5) d;
