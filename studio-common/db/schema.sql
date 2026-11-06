--
-- PostgreSQL database dump
--

\restrict h1mB3fvNxuNSx1pdsgOdZODg20x05PeH9czzIBUEubjENeLkeZ2Ke5vd7JhlGua

-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: prompt_templates_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prompt_templates_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- 只整理分类（或无实际字段变化）时，保留原更新时间，避免误切换同key的生效版本。
  IF (to_jsonb(NEW)-'category') IS NOT DISTINCT FROM (to_jsonb(OLD)-'category') THEN RETURN NEW; END IF;
  NEW.updated_at=clock_timestamp(); RETURN NEW;
END; $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cast_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cast_members (
    speaker text NOT NULL,
    role text NOT NULL,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cast_members_role_check CHECK ((role = ANY (ARRAY['主角'::text, '配角'::text])))
);


--
-- Name: game_fixed_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_fixed_terms (
    id integer NOT NULL,
    term text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT game_fixed_terms_term_check CHECK (((char_length(term) >= 1) AND (char_length(term) <= 80)))
);


--
-- Name: game_fixed_terms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.game_fixed_terms ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.game_fixed_terms_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id bigint NOT NULL,
    kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.jobs_id_seq OWNED BY public.jobs.id;


--
-- Name: line_auto_run_comparisons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.line_auto_run_comparisons (
    run_id bigint NOT NULL,
    tts_id bigint NOT NULL,
    metric_version text NOT NULL,
    reference_audio_path text NOT NULL,
    reference_sha256 text NOT NULL,
    candidate_audio_path text NOT NULL,
    candidate_sha256 text NOT NULL,
    reference_span_ms double precision,
    candidate_span_ms double precision,
    span_ratio double precision,
    span_check_enabled boolean NOT NULL,
    span_pass boolean NOT NULL,
    reference_text_jp text NOT NULL,
    candidate_text_cn text NOT NULL,
    beat_version text,
    normalized_beat_ratio double precision,
    beat_result jsonb,
    beat_error text,
    measured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT line_auto_run_comparisons_candidate_span_ms_check CHECK ((candidate_span_ms > (0)::double precision)),
    CONSTRAINT line_auto_run_comparisons_reference_span_ms_check CHECK ((reference_span_ms > (0)::double precision)),
    CONSTRAINT line_auto_run_comparisons_span_ratio_check CHECK ((span_ratio > (0)::double precision))
);


--
-- Name: line_auto_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.line_auto_run_events (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    step text NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    message text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT line_auto_run_events_level_check CHECK ((level = ANY (ARRAY['info'::text, 'think'::text, 'asr'::text, 'result'::text, 'error'::text])))
);


--
-- Name: line_auto_run_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.line_auto_run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: line_auto_run_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.line_auto_run_events_id_seq OWNED BY public.line_auto_run_events.id;


--
-- Name: line_auto_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.line_auto_runs (
    id bigint NOT NULL,
    stem text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    selected_tts_id bigint,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    reference_audio_path text,
    reference_text_jp text,
    reference_seed_asr jsonb,
    CONSTRAINT line_auto_runs_kind_check CHECK ((kind = ANY (ARRAY['performance'::text, 'casual'::text]))),
    CONSTRAINT line_auto_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'passed'::text, 'failed'::text])))
);


--
-- Name: line_auto_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.line_auto_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: line_auto_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.line_auto_runs_id_seq OWNED BY public.line_auto_runs.id;


--
-- Name: line_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.line_meta (
    stem text NOT NULL,
    actor_zh text,
    actor_jp text,
    note text,
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    jp_start_s double precision,
    jp_end_s double precision,
    jp_dur_s double precision,
    jp_speech_s double precision,
    cn_start_s double precision,
    cn_end_s double precision,
    cn_dur_s double precision,
    cn_speech_s double precision,
    jp_emo text,
    cn_emo text,
    persona text,
    jp_emo_angry double precision,
    jp_emo_disgusted double precision,
    jp_emo_fearful double precision,
    jp_emo_happy double precision,
    jp_emo_neutral double precision,
    jp_emo_other double precision,
    jp_emo_sad double precision,
    jp_emo_surprised double precision,
    cn_emo_angry double precision,
    cn_emo_disgusted double precision,
    cn_emo_fearful double precision,
    cn_emo_happy double precision,
    cn_emo_neutral double precision,
    cn_emo_other double precision,
    cn_emo_sad double precision,
    cn_emo_surprised double precision,
    emo_src text,
    jp_spk_sim_red double precision,
    en_start_s double precision,
    en_end_s double precision,
    en_dur_s double precision,
    en_speech_s double precision,
    skip_timing boolean DEFAULT false NOT NULL,
    dialogue_mode text,
    dialogue_evidence jsonb,
    beat_jp_hash text,
    beat_cn_hash text,
    beat_version text,
    beat_status text,
    beat_ratio double precision,
    beat_mark text,
    seed_asr jsonb,
    CONSTRAINT line_meta_emo_src_check CHECK ((emo_src = ANY (ARRAY['computed'::text, 'edited'::text]))),
    CONSTRAINT line_meta_skip_timing_retired CHECK ((skip_timing IS NOT TRUE))
);


--
-- Name: line_translation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.line_translation_jobs (
    stem text NOT NULL,
    source_language text NOT NULL,
    source_hash text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error text,
    model text,
    name_reference_revision text,
    name_review_target text,
    previous_translation text,
    name_review_priority integer DEFAULT 0 NOT NULL,
    CONSTRAINT line_translation_jobs_source_language_check CHECK ((source_language = ANY (ARRAY['jp'::text, 'en'::text]))),
    CONSTRAINT line_translation_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'retry'::text])))
);


--
-- Name: line_tts_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.line_tts_versions (
    id bigint NOT NULL,
    stem text NOT NULL,
    speaker text,
    voice_version_id integer,
    voice_gpu_key text NOT NULL,
    tts_text text NOT NULL,
    spoken_text text NOT NULL,
    subtitle_text text,
    jp_text_snapshot text,
    game_zh_text_snapshot text,
    duration_factor double precision DEFAULT 1.0 NOT NULL,
    emo_alpha double precision DEFAULT 0.5 NOT NULL,
    audio_path text,
    audio_bytes bigint,
    dur_s double precision,
    used_at timestamp with time zone,
    status text DEFAULT 'building'::text NOT NULL,
    error text,
    engine_model_version text,
    engine_model_revision text,
    engine_source_revision text,
    engine_package_version text,
    engine_precision text,
    engine_device text,
    engine_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    start_s double precision,
    end_s double precision,
    speech_s double precision,
    conversion_meta jsonb,
    raw_audio_path text,
    manifest_path text,
    heard_at timestamp with time zone,
    seed_asr jsonb,
    auto_run_id bigint,
    parent_tts_id bigint,
    llm_tokens jsonb,
    llm_speed jsonb,
    play_count integer DEFAULT 0 NOT NULL,
    review_state text DEFAULT 'candidate'::text NOT NULL,
    CONSTRAINT line_tts_versions_duration_factor_check CHECK (((duration_factor >= (0.5)::double precision) AND (duration_factor <= (2.0)::double precision))),
    CONSTRAINT line_tts_versions_emo_alpha_check CHECK (((emo_alpha >= (0.0)::double precision) AND (emo_alpha <= (1.0)::double precision))),
    CONSTRAINT line_tts_versions_play_count_check CHECK ((play_count >= 0)),
    CONSTRAINT line_tts_versions_review_state_check CHECK ((review_state = ANY (ARRAY['candidate'::text, 'locked'::text, 'abnormal'::text]))),
    CONSTRAINT line_tts_versions_spoken_text_check CHECK ((btrim(spoken_text) <> ''::text)),
    CONSTRAINT line_tts_versions_status_check CHECK ((status = ANY (ARRAY['building'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT line_tts_versions_tts_text_check CHECK ((btrim(tts_text) <> ''::text)),
    CONSTRAINT tts_llm_metrics_root_only CHECK (((parent_tts_id IS NULL) OR ((llm_tokens IS NULL) AND (llm_speed IS NULL)))),
    CONSTRAINT tts_parent_not_self CHECK ((parent_tts_id IS DISTINCT FROM id))
);


--
-- Name: line_tts_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.line_tts_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: line_tts_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.line_tts_versions_id_seq OWNED BY public.line_tts_versions.id;


--
-- Name: lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lines (
    id bigint NOT NULL,
    pack text NOT NULL,
    filename text NOT NULL,
    stem text NOT NULL,
    asset_path text,
    region text,
    speaker text,
    kind text,
    jp_chunk_id text,
    jp_container text,
    text_jp text,
    text_zh text,
    script text,
    status text DEFAULT 'upstream'::text NOT NULL,
    slot_ms integer,
    cn_ms integer,
    ours_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    text_en text,
    subtitle_italic boolean DEFAULT false NOT NULL,
    translate_zh_jp text,
    translate_zh_en text
);


--
-- Name: lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lines_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lines_id_seq OWNED BY public.lines.id;


--
-- Name: llm_access_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_access_logs (
    id bigint NOT NULL,
    invocation_id uuid NOT NULL,
    attempt integer NOT NULL,
    auto_run_id bigint,
    stem text,
    task text NOT NULL,
    endpoint text NOT NULL,
    requested_model text NOT NULL,
    response_model text,
    prompt_keys text[] DEFAULT '{}'::text[] NOT NULL,
    request_body jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    response_body jsonb,
    response_raw text,
    output_text text,
    reasoning_text text,
    usage jsonb,
    input_tokens bigint,
    output_tokens bigint,
    total_tokens bigint,
    cached_tokens bigint,
    reasoning_tokens bigint,
    elapsed_ms double precision,
    output_tokens_per_second double precision,
    http_status integer,
    request_id text,
    error text,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT llm_access_logs_attempt_check CHECK ((attempt > 0)),
    CONSTRAINT llm_access_logs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'success'::text, 'http-error'::text, 'network-error'::text, 'invalid-json'::text, 'invalid-response'::text, 'truncated'::text, 'repetition-detected'::text, 'stream-error'::text, 'timeout'::text, 'cancelled'::text])))
);


--
-- Name: llm_access_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.llm_access_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: llm_access_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.llm_access_logs_id_seq OWNED BY public.llm_access_logs.id;


--
-- Name: prompt_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_group_members (
    group_key text NOT NULL,
    prompt_key text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);


--
-- Name: prompt_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_groups (
    key text NOT NULL,
    name text NOT NULL,
    "desc" text DEFAULT ''::text NOT NULL,
    category text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: prompt_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_templates (
    id bigint NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    "desc" text DEFAULT ''::text NOT NULL,
    prompt text NOT NULL,
    enable boolean DEFAULT true NOT NULL,
    role text NOT NULL,
    placeholders jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_path text,
    seed_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category text DEFAULT '未分类'::text NOT NULL,
    CONSTRAINT prompt_templates_category_check CHECK ((length(btrim(category)) > 0)),
    CONSTRAINT prompt_templates_key_check CHECK ((key ~ '^[a-z][a-z0-9._-]*$'::text)),
    CONSTRAINT prompt_templates_placeholders_check CHECK ((jsonb_typeof(placeholders) = 'array'::text)),
    CONSTRAINT prompt_templates_prompt_check CHECK ((length(prompt) > 0)),
    CONSTRAINT prompt_templates_role_check CHECK ((role = ANY (ARRAY['system'::text, 'user'::text, 'assistant'::text])))
);


--
-- Name: prompt_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prompt_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prompt_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prompt_templates_id_seq OWNED BY public.prompt_templates.id;


--
-- Name: pronunciations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pronunciations (
    id bigint NOT NULL,
    src text NOT NULL,
    dst text NOT NULL,
    note text,
    usage text DEFAULT 'reference'::text NOT NULL,
    CONSTRAINT pronunciations_usage_check CHECK ((usage = ANY (ARRAY['reference'::text, 'tts_pinyin'::text])))
);


--
-- Name: pronunciations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pronunciations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pronunciations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pronunciations_id_seq OWNED BY public.pronunciations.id;


--
-- Name: regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regions (
    code text NOT NULL,
    name_zh text,
    name_jp text,
    note text,
    source text DEFAULT 'seed'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sort_order integer
);


--
-- Name: speaker_timbre_refs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.speaker_timbre_refs (
    speaker text NOT NULL,
    stem text NOT NULL,
    ordinal integer DEFAULT 1 NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    note text DEFAULT ''::text NOT NULL
);


--
-- Name: speakers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.speakers (
    code text NOT NULL,
    name_zh text,
    name_jp text,
    source text DEFAULT 'txtres'::text NOT NULL,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tts_defaults jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: speech_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.speech_metrics (
    cache_key text NOT NULL,
    audio_path text NOT NULL,
    language text NOT NULL,
    source_text text NOT NULL,
    file_version text NOT NULL,
    algorithm_version text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    duration_s double precision,
    silence_s double precision,
    net_speech_s double precision,
    unit_count double precision,
    units_per_s double precision,
    result jsonb,
    last_error text,
    attempts integer DEFAULT 0 NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    measured_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT speech_metrics_language_check CHECK ((language = ANY (ARRAY['jp'::text, 'cn'::text]))),
    CONSTRAINT speech_metrics_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'error'::text])))
);


--
-- Name: voice_bank_draft_clips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_bank_draft_clips (
    bank_id integer NOT NULL,
    stem text NOT NULL,
    selected boolean DEFAULT true NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    recommended boolean DEFAULT false NOT NULL
);


--
-- Name: voice_bank_version_clips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_bank_version_clips (
    version_id integer NOT NULL,
    stem text NOT NULL,
    ordinal integer,
    batch_no integer
);


--
-- Name: voice_bank_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_bank_versions (
    id integer NOT NULL,
    bank_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    n_clips integer DEFAULT 0 NOT NULL,
    total_dur_s double precision,
    embedding_path text,
    reference_wav_path text,
    note text,
    status text DEFAULT 'ready'::text NOT NULL,
    gpu_speaker_key text,
    result_dir text,
    manifest_path text,
    batch_count integer,
    similarity_min double precision,
    similarity_mean double precision,
    similarity_max double precision,
    example_stem text,
    example_emo_alpha double precision,
    example_zh_path text,
    example_ja_path text,
    error text,
    completed_at timestamp with time zone,
    engine_model_version text,
    engine_model_revision text,
    engine_source_revision text,
    engine_package_version text,
    engine_precision text,
    engine_device text,
    engine_url text,
    source_lang text DEFAULT 'cn'::text NOT NULL,
    source_wav_path text,
    CONSTRAINT voice_bank_versions_source_lang_check CHECK ((source_lang = ANY (ARRAY['jp'::text, 'cn'::text, 'en'::text]))),
    CONSTRAINT voice_bank_versions_status_check CHECK ((status = ANY (ARRAY['building'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: voice_bank_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.voice_bank_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: voice_bank_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.voice_bank_versions_id_seq OWNED BY public.voice_bank_versions.id;


--
-- Name: voice_banks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_banks (
    id integer NOT NULL,
    speaker text NOT NULL,
    kind text NOT NULL,
    slot integer DEFAULT 1 NOT NULL,
    name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_banks_kind_check CHECK ((kind = ANY (ARRAY['基准'::text, '怒'::text, '喜'::text, '平'::text, '悲'::text, '惧'::text, '惊'::text])))
);


--
-- Name: voice_banks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.voice_banks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: voice_banks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.voice_banks_id_seq OWNED BY public.voice_banks.id;


--
-- Name: jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs ALTER COLUMN id SET DEFAULT nextval('public.jobs_id_seq'::regclass);


--
-- Name: line_auto_run_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_run_events ALTER COLUMN id SET DEFAULT nextval('public.line_auto_run_events_id_seq'::regclass);


--
-- Name: line_auto_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_runs ALTER COLUMN id SET DEFAULT nextval('public.line_auto_runs_id_seq'::regclass);


--
-- Name: line_tts_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_tts_versions ALTER COLUMN id SET DEFAULT nextval('public.line_tts_versions_id_seq'::regclass);


--
-- Name: lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lines ALTER COLUMN id SET DEFAULT nextval('public.lines_id_seq'::regclass);


--
-- Name: llm_access_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_access_logs ALTER COLUMN id SET DEFAULT nextval('public.llm_access_logs_id_seq'::regclass);


--
-- Name: prompt_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_templates ALTER COLUMN id SET DEFAULT nextval('public.prompt_templates_id_seq'::regclass);


--
-- Name: pronunciations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pronunciations ALTER COLUMN id SET DEFAULT nextval('public.pronunciations_id_seq'::regclass);


--
-- Name: voice_bank_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_versions ALTER COLUMN id SET DEFAULT nextval('public.voice_bank_versions_id_seq'::regclass);


--
-- Name: voice_banks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_banks ALTER COLUMN id SET DEFAULT nextval('public.voice_banks_id_seq'::regclass);


--
-- Name: cast_members cast_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cast_members
    ADD CONSTRAINT cast_members_pkey PRIMARY KEY (speaker);


--
-- Name: game_fixed_terms game_fixed_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_fixed_terms
    ADD CONSTRAINT game_fixed_terms_pkey PRIMARY KEY (id);


--
-- Name: game_fixed_terms game_fixed_terms_term_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_fixed_terms
    ADD CONSTRAINT game_fixed_terms_term_key UNIQUE (term);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: line_auto_run_comparisons line_auto_run_comparisons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_run_comparisons
    ADD CONSTRAINT line_auto_run_comparisons_pkey PRIMARY KEY (run_id, tts_id);


--
-- Name: line_auto_run_events line_auto_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_run_events
    ADD CONSTRAINT line_auto_run_events_pkey PRIMARY KEY (id);


--
-- Name: line_auto_runs line_auto_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_runs
    ADD CONSTRAINT line_auto_runs_pkey PRIMARY KEY (id);


--
-- Name: line_meta line_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_meta
    ADD CONSTRAINT line_meta_pkey PRIMARY KEY (stem);


--
-- Name: line_translation_jobs line_translation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_translation_jobs
    ADD CONSTRAINT line_translation_jobs_pkey PRIMARY KEY (stem, source_language);


--
-- Name: line_tts_versions line_tts_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_tts_versions
    ADD CONSTRAINT line_tts_versions_pkey PRIMARY KEY (id);


--
-- Name: lines lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lines
    ADD CONSTRAINT lines_pkey PRIMARY KEY (id);


--
-- Name: lines lines_stem_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lines
    ADD CONSTRAINT lines_stem_key UNIQUE (stem);


--
-- Name: llm_access_logs llm_access_logs_invocation_id_attempt_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_access_logs
    ADD CONSTRAINT llm_access_logs_invocation_id_attempt_key UNIQUE (invocation_id, attempt);


--
-- Name: llm_access_logs llm_access_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_access_logs
    ADD CONSTRAINT llm_access_logs_pkey PRIMARY KEY (id);


--
-- Name: prompt_group_members prompt_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_group_members
    ADD CONSTRAINT prompt_group_members_pkey PRIMARY KEY (group_key, prompt_key);


--
-- Name: prompt_groups prompt_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_groups
    ADD CONSTRAINT prompt_groups_pkey PRIMARY KEY (key);


--
-- Name: prompt_templates prompt_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_templates
    ADD CONSTRAINT prompt_templates_pkey PRIMARY KEY (id);


--
-- Name: prompt_templates prompt_templates_seed_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_templates
    ADD CONSTRAINT prompt_templates_seed_hash_key UNIQUE (seed_hash);


--
-- Name: pronunciations pronunciations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pronunciations
    ADD CONSTRAINT pronunciations_pkey PRIMARY KEY (id);


--
-- Name: regions regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_pkey PRIMARY KEY (code);


--
-- Name: speaker_timbre_refs speaker_timbre_refs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.speaker_timbre_refs
    ADD CONSTRAINT speaker_timbre_refs_pkey PRIMARY KEY (speaker, stem);


--
-- Name: speakers speakers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.speakers
    ADD CONSTRAINT speakers_pkey PRIMARY KEY (code);


--
-- Name: speech_metrics speech_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.speech_metrics
    ADD CONSTRAINT speech_metrics_pkey PRIMARY KEY (cache_key);


--
-- Name: voice_bank_draft_clips voice_bank_draft_clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_draft_clips
    ADD CONSTRAINT voice_bank_draft_clips_pkey PRIMARY KEY (bank_id, stem);


--
-- Name: voice_bank_version_clips voice_bank_version_clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_version_clips
    ADD CONSTRAINT voice_bank_version_clips_pkey PRIMARY KEY (version_id, stem);


--
-- Name: voice_bank_versions voice_bank_versions_gpu_speaker_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_versions
    ADD CONSTRAINT voice_bank_versions_gpu_speaker_key_key UNIQUE (gpu_speaker_key);


--
-- Name: voice_bank_versions voice_bank_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_versions
    ADD CONSTRAINT voice_bank_versions_pkey PRIMARY KEY (id);


--
-- Name: voice_banks voice_banks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_banks
    ADD CONSTRAINT voice_banks_pkey PRIMARY KEY (id);


--
-- Name: voice_banks voice_banks_speaker_kind_slot_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_banks
    ADD CONSTRAINT voice_banks_speaker_kind_slot_key UNIQUE (speaker, kind, slot);


--
-- Name: cast_members_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cast_members_role_idx ON public.cast_members USING btree (role);


--
-- Name: line_auto_run_events_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_auto_run_events_run_idx ON public.line_auto_run_events USING btree (run_id, id);


--
-- Name: line_auto_runs_one_running_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX line_auto_runs_one_running_idx ON public.line_auto_runs USING btree (stem) WHERE (status = 'running'::text);


--
-- Name: line_auto_runs_reference_asr_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_auto_runs_reference_asr_idx ON public.line_auto_runs USING btree (((reference_seed_asr ->> 'sha256'::text))) WHERE (reference_seed_asr IS NOT NULL);


--
-- Name: line_auto_runs_stem_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX line_auto_runs_stem_id_unique ON public.line_auto_runs USING btree (stem, id);


--
-- Name: line_auto_runs_stem_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_auto_runs_stem_idx ON public.line_auto_runs USING btree (stem, id DESC);


--
-- Name: line_meta_actor_zh_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_actor_zh_idx ON public.line_meta USING btree (actor_zh);


--
-- Name: line_meta_cn_emo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_cn_emo_idx ON public.line_meta USING btree (cn_emo);


--
-- Name: line_meta_cn_speech_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_cn_speech_idx ON public.line_meta USING btree (cn_speech_s);


--
-- Name: line_meta_dialogue_mode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_dialogue_mode_idx ON public.line_meta USING btree (dialogue_mode);


--
-- Name: line_meta_emo_src_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_emo_src_idx ON public.line_meta USING btree (emo_src);


--
-- Name: line_meta_jp_emo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_jp_emo_idx ON public.line_meta USING btree (jp_emo);


--
-- Name: line_meta_jp_emo_neutral_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_jp_emo_neutral_idx ON public.line_meta USING btree (jp_emo_neutral);


--
-- Name: line_meta_jp_speech_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_jp_speech_idx ON public.line_meta USING btree (jp_speech_s);


--
-- Name: line_meta_jp_spk_sim_red_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_jp_spk_sim_red_idx ON public.line_meta USING btree (jp_spk_sim_red);


--
-- Name: line_meta_persona_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_persona_idx ON public.line_meta USING btree (persona);


--
-- Name: line_meta_seed_asr_sha256_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_seed_asr_sha256_idx ON public.line_meta USING btree (((seed_asr ->> 'sha256'::text))) WHERE (seed_asr IS NOT NULL);


--
-- Name: line_meta_skip_timing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_meta_skip_timing_idx ON public.line_meta USING btree (skip_timing) WHERE skip_timing;


--
-- Name: line_translation_jobs_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_translation_jobs_dispatch ON public.line_translation_jobs USING btree (status, next_attempt_at);


--
-- Name: line_tts_conversion_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_tts_conversion_source_idx ON public.line_tts_versions USING btree (((conversion_meta ->> 'source_id'::text))) WHERE (conversion_meta IS NOT NULL);


--
-- Name: line_tts_versions_auto_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_tts_versions_auto_run_idx ON public.line_tts_versions USING btree (auto_run_id) WHERE (auto_run_id IS NOT NULL);


--
-- Name: line_tts_versions_list_visible_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_tts_versions_list_visible_idx ON public.line_tts_versions USING btree (stem, ((review_state <> 'candidate'::text)) DESC, ((parent_tts_id IS NULL)) DESC, id DESC) INCLUDE (subtitle_text) WHERE (status = 'ready'::text);


--
-- Name: line_tts_versions_one_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX line_tts_versions_one_review_idx ON public.line_tts_versions USING btree (stem) WHERE (review_state = ANY (ARRAY['locked'::text, 'abnormal'::text]));


--
-- Name: line_tts_versions_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_tts_versions_parent_idx ON public.line_tts_versions USING btree (parent_tts_id) WHERE (parent_tts_id IS NOT NULL);


--
-- Name: line_tts_versions_seed_asr_sha256_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_tts_versions_seed_asr_sha256_idx ON public.line_tts_versions USING btree (((seed_asr ->> 'sha256'::text))) WHERE (seed_asr IS NOT NULL);


--
-- Name: line_tts_versions_speaker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_tts_versions_speaker_idx ON public.line_tts_versions USING btree (speaker, id DESC);


--
-- Name: line_tts_versions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_tts_versions_status_idx ON public.line_tts_versions USING btree (status, id DESC);


--
-- Name: line_tts_versions_stem_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX line_tts_versions_stem_id_unique ON public.line_tts_versions USING btree (stem, id);


--
-- Name: line_tts_versions_stem_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_tts_versions_stem_latest_idx ON public.line_tts_versions USING btree (stem, id DESC);


--
-- Name: line_tts_versions_voice_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX line_tts_versions_voice_version_idx ON public.line_tts_versions USING btree (voice_version_id);


--
-- Name: lines_pack_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lines_pack_idx ON public.lines USING btree (pack);


--
-- Name: lines_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lines_region_idx ON public.lines USING btree (region);


--
-- Name: lines_speaker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lines_speaker_idx ON public.lines USING btree (speaker);


--
-- Name: lines_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lines_status_idx ON public.lines USING btree (status);


--
-- Name: lines_subtitle_italic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lines_subtitle_italic_idx ON public.lines USING btree (subtitle_italic) WHERE subtitle_italic;


--
-- Name: llm_access_logs_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_access_logs_run_idx ON public.llm_access_logs USING btree (auto_run_id, id);


--
-- Name: llm_access_logs_stem_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_access_logs_stem_idx ON public.llm_access_logs USING btree (stem, id DESC);


--
-- Name: llm_access_logs_task_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_access_logs_task_time_idx ON public.llm_access_logs USING btree (task, started_at DESC);


--
-- Name: llm_access_logs_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_access_logs_time_idx ON public.llm_access_logs USING btree (started_at DESC);


--
-- Name: prompt_group_members_prompt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_group_members_prompt_idx ON public.prompt_group_members USING btree (prompt_key);


--
-- Name: prompt_templates_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_templates_category_idx ON public.prompt_templates USING btree (category);


--
-- Name: prompt_templates_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_templates_lookup_idx ON public.prompt_templates USING btree (key, enable DESC, updated_at DESC, id DESC);


--
-- Name: pronunciations_usage_src_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pronunciations_usage_src_key ON public.pronunciations USING btree (usage, src);


--
-- Name: regions_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX regions_sort_idx ON public.regions USING btree (sort_order);


--
-- Name: speaker_timbre_refs_speaker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX speaker_timbre_refs_speaker_idx ON public.speaker_timbre_refs USING btree (speaker, ordinal, stem);


--
-- Name: speech_metrics_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX speech_metrics_pending_idx ON public.speech_metrics USING btree (priority DESC, queued_at) WHERE (status = 'pending'::text);


--
-- Name: voice_bank_draft_clips_stem_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_bank_draft_clips_stem_idx ON public.voice_bank_draft_clips USING btree (stem);


--
-- Name: voice_bank_version_clips_stem_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_bank_version_clips_stem_idx ON public.voice_bank_version_clips USING btree (stem);


--
-- Name: voice_bank_versions_bank_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_bank_versions_bank_idx ON public.voice_bank_versions USING btree (bank_id, created_at DESC);


--
-- Name: voice_bank_versions_example_stem_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_bank_versions_example_stem_idx ON public.voice_bank_versions USING btree (example_stem);


--
-- Name: voice_bank_versions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_bank_versions_status_idx ON public.voice_bank_versions USING btree (status, created_at DESC);


--
-- Name: voice_banks_speaker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_banks_speaker_idx ON public.voice_banks USING btree (speaker);


--
-- Name: prompt_templates prompt_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prompt_templates_updated_at BEFORE UPDATE ON public.prompt_templates FOR EACH ROW EXECUTE FUNCTION public.prompt_templates_touch_updated_at();


--
-- Name: cast_members cast_members_speaker_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cast_members
    ADD CONSTRAINT cast_members_speaker_fkey FOREIGN KEY (speaker) REFERENCES public.speakers(code) ON DELETE CASCADE;


--
-- Name: line_auto_run_comparisons line_auto_run_comparisons_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_run_comparisons
    ADD CONSTRAINT line_auto_run_comparisons_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.line_auto_runs(id) ON DELETE CASCADE;


--
-- Name: line_auto_run_comparisons line_auto_run_comparisons_tts_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_run_comparisons
    ADD CONSTRAINT line_auto_run_comparisons_tts_id_fkey FOREIGN KEY (tts_id) REFERENCES public.line_tts_versions(id) ON DELETE CASCADE;


--
-- Name: line_auto_run_events line_auto_run_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_run_events
    ADD CONSTRAINT line_auto_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.line_auto_runs(id) ON DELETE CASCADE;


--
-- Name: line_auto_runs line_auto_runs_selected_tts_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_runs
    ADD CONSTRAINT line_auto_runs_selected_tts_id_fkey FOREIGN KEY (selected_tts_id) REFERENCES public.line_tts_versions(id) ON DELETE SET NULL;


--
-- Name: line_auto_runs line_auto_runs_stem_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_auto_runs
    ADD CONSTRAINT line_auto_runs_stem_fkey FOREIGN KEY (stem) REFERENCES public.lines(stem) ON DELETE CASCADE;


--
-- Name: line_meta line_meta_stem_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_meta
    ADD CONSTRAINT line_meta_stem_fkey FOREIGN KEY (stem) REFERENCES public.lines(stem) ON DELETE CASCADE;


--
-- Name: line_translation_jobs line_translation_jobs_stem_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_translation_jobs
    ADD CONSTRAINT line_translation_jobs_stem_fkey FOREIGN KEY (stem) REFERENCES public.lines(stem) ON DELETE CASCADE;


--
-- Name: line_tts_versions line_tts_versions_speaker_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_tts_versions
    ADD CONSTRAINT line_tts_versions_speaker_fkey FOREIGN KEY (speaker) REFERENCES public.speakers(code) ON DELETE RESTRICT;


--
-- Name: line_tts_versions line_tts_versions_stem_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_tts_versions
    ADD CONSTRAINT line_tts_versions_stem_fkey FOREIGN KEY (stem) REFERENCES public.lines(stem) ON DELETE CASCADE;


--
-- Name: line_tts_versions line_tts_versions_voice_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_tts_versions
    ADD CONSTRAINT line_tts_versions_voice_version_id_fkey FOREIGN KEY (voice_version_id) REFERENCES public.voice_bank_versions(id) ON DELETE SET NULL;


--
-- Name: prompt_group_members prompt_group_members_group_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_group_members
    ADD CONSTRAINT prompt_group_members_group_key_fkey FOREIGN KEY (group_key) REFERENCES public.prompt_groups(key) ON DELETE CASCADE;


--
-- Name: speaker_timbre_refs speaker_timbre_refs_speaker_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.speaker_timbre_refs
    ADD CONSTRAINT speaker_timbre_refs_speaker_fkey FOREIGN KEY (speaker) REFERENCES public.speakers(code) ON DELETE CASCADE;


--
-- Name: speaker_timbre_refs speaker_timbre_refs_stem_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.speaker_timbre_refs
    ADD CONSTRAINT speaker_timbre_refs_stem_fkey FOREIGN KEY (stem) REFERENCES public.lines(stem) ON DELETE CASCADE;


--
-- Name: line_tts_versions tts_parent_same_stem_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_tts_versions
    ADD CONSTRAINT tts_parent_same_stem_fk FOREIGN KEY (stem, parent_tts_id) REFERENCES public.line_tts_versions(stem, id) ON DELETE SET NULL (parent_tts_id);


--
-- Name: line_tts_versions tts_workflow_same_stem_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.line_tts_versions
    ADD CONSTRAINT tts_workflow_same_stem_fk FOREIGN KEY (stem, auto_run_id) REFERENCES public.line_auto_runs(stem, id) ON DELETE SET NULL (auto_run_id);


--
-- Name: voice_bank_draft_clips voice_bank_draft_clips_bank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_draft_clips
    ADD CONSTRAINT voice_bank_draft_clips_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES public.voice_banks(id) ON DELETE CASCADE;


--
-- Name: voice_bank_draft_clips voice_bank_draft_clips_stem_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_draft_clips
    ADD CONSTRAINT voice_bank_draft_clips_stem_fkey FOREIGN KEY (stem) REFERENCES public.lines(stem) ON DELETE CASCADE;


--
-- Name: voice_bank_version_clips voice_bank_version_clips_stem_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_version_clips
    ADD CONSTRAINT voice_bank_version_clips_stem_fkey FOREIGN KEY (stem) REFERENCES public.lines(stem) ON DELETE CASCADE;


--
-- Name: voice_bank_version_clips voice_bank_version_clips_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_version_clips
    ADD CONSTRAINT voice_bank_version_clips_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.voice_bank_versions(id) ON DELETE CASCADE;


--
-- Name: voice_bank_versions voice_bank_versions_bank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_versions
    ADD CONSTRAINT voice_bank_versions_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES public.voice_banks(id) ON DELETE CASCADE;


--
-- Name: voice_bank_versions voice_bank_versions_example_stem_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_bank_versions
    ADD CONSTRAINT voice_bank_versions_example_stem_fkey FOREIGN KEY (example_stem) REFERENCES public.lines(stem) ON DELETE SET NULL;


--
-- Name: voice_banks voice_banks_speaker_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_banks
    ADD CONSTRAINT voice_banks_speaker_fkey FOREIGN KEY (speaker) REFERENCES public.speakers(code) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict h1mB3fvNxuNSx1pdsgOdZODg20x05PeH9czzIBUEubjENeLkeZ2Ke5vd7JhlGua


-- Independent ASR comparison aliases. Never apply these rows to TTS or subtitles.
CREATE TABLE IF NOT EXISTS asr_word_corrections (
  id SERIAL PRIMARY KEY,
  word TEXT NOT NULL UNIQUE CHECK (length(word) BETWEEN 1 AND 40),
  aliases TEXT[] NOT NULL CHECK (cardinality(aliases) BETWEEN 1 AND 64),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A line-level decision, independent of retained audio versions and review locks.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS processing_state TEXT NOT NULL DEFAULT 'active'
  CHECK (processing_state IN ('active','skipped'));
ALTER TABLE lines ADD COLUMN IF NOT EXISTS skip_reason TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS skipped_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS lines_processing_state_stem_idx ON lines(processing_state,stem);
CREATE TABLE IF NOT EXISTS line_processing_events (
  id BIGSERIAL PRIMARY KEY,
  stem TEXT NOT NULL REFERENCES lines(stem) ON DELETE CASCADE,
  from_state TEXT NOT NULL CHECK (from_state IN ('active','skipped')),
  to_state TEXT NOT NULL CHECK (to_state IN ('active','skipped')),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 097: 人物未知的本句JP克隆及派生，仍须核字、时长及参考证据。
-- 人物未知也可用本句日文做zero-shot；不伪造人物，仍保留人物外键。
-- 只有带本句参考来源记录的zeroshot-jp及其audio-edit派生可为NULL。
BEGIN;
ALTER TABLE line_tts_versions DROP CONSTRAINT IF EXISTS line_tts_versions_anonymous_original_only;
ALTER TABLE line_tts_versions DROP CONSTRAINT IF EXISTS line_tts_versions_anonymous_audio_policy;
ALTER TABLE line_tts_versions ADD CONSTRAINT line_tts_versions_anonymous_audio_policy CHECK (
  speaker IS NOT NULL OR voice_gpu_key='jp-lock' OR COALESCE((
    voice_gpu_key IN ('zeroshot-jp','audio-edit')
    AND conversion_meta->'anonymous_single_line'->>'version'='anonymous-self-reference-v1'
    AND conversion_meta->'anonymous_single_line'->>'stem'=stem
    AND conversion_meta->'anonymous_single_line'->>'context'='none'
    AND conversion_meta->'anonymous_single_line'->>'source_audio_path'='jp/'||stem||'.mp3'
    AND conversion_meta->'anonymous_single_line'->>'source_audio_sha256' ~ '^[a-f0-9]{64}$'
    AND conversion_meta->'anonymous_single_line'->>'reference_audio_sha256' ~ '^[a-f0-9]{64}$'
    AND (conversion_meta->'anonymous_single_line'->>'reference_audio_path'='jp/'||stem||'.mp3'
      OR starts_with(conversion_meta->'anonymous_single_line'->>'reference_audio_path','tts/'||stem||'/'))
  ),false)
);
COMMENT ON COLUMN line_tts_versions.speaker IS
  '人物可未知：jp-lock原声或带本句JP参考证据的zero-shot/编辑派生允许NULL；不猜人物、不给邻句上下文。';
COMMIT;


-- 098: Empty per-game interface settings; no configuration data is seeded.
-- Per-game connection configuration; credentials stay in the private database.
BEGIN;
CREATE TABLE IF NOT EXISTS auto_run_settings (
 id smallint PRIMARY KEY CHECK(id=1),
 model text NOT NULL DEFAULT 'grok' CHECK(model IN ('grok','primary')),
 connections jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(connections)='object'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auto_run_settings_events (
 id bigserial PRIMARY KEY,
 previous_model text NOT NULL,
 model text NOT NULL,
 changes jsonb NOT NULL DEFAULT '[]'::jsonb,
 at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN auto_run_settings.connections IS '私密接口配置，含API密钥；禁止日志输出、发布或导出到公共报告';
DO $$ BEGIN
 IF current_database()='studio_ff7_remake' AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ff7remake') THEN
  GRANT SELECT,INSERT,UPDATE ON auto_run_settings TO ff7remake;
  GRANT SELECT,INSERT ON auto_run_settings_events TO ff7remake;
  GRANT USAGE,SELECT ON SEQUENCE auto_run_settings_events_id_seq TO ff7remake;
 END IF;
END $$;
COMMIT;
