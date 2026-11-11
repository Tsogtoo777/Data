-- REVIEW IN STAGING BEFORE EXECUTING IN PRODUCTION.
-- Status-only replay; original capture timestamp; server-side idempotency.
-- Does NOT replay SMU/KM; those drafts remain for manual review.
BEGIN;
CREATE TABLE IF NOT EXISTS public.ets_offline_request_log_v1 (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  equipment_key text NOT NULL,
  event_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ets_offline_request_log_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ets_offline_request_log_v1 FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ets_offline_status_v1(
  p_request uuid,
  p_equipment text,
  p_status text,
  p_recorded_at timestamptz,
  p_operator text DEFAULT NULL,
  p_comment text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_role text := COALESCE(auth.jwt()->'app_metadata'->>'role','');
  v_equipment public.equipment%ROWTYPE;
  v_prev public.equipment_events%ROWTYPE;
  v_existing public.ets_offline_request_log_v1%ROWTYPE;
  v_event_id text;
BEGIN
  IF v_user IS NULL OR v_role NOT IN ('event_editor','master','dispatcher','management','admin') THEN
    RAISE EXCEPTION 'Offline status: not authorized' USING ERRCODE='42501';
  END IF;
  IF p_request IS NULL OR NULLIF(btrim(p_equipment),'') IS NULL OR
     NULLIF(btrim(p_status),'') IS NULL OR p_recorded_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID','message','Техник, төлөв, цаг эсвэл ID дутуу.');
  END IF;
  IF p_recorded_at > now()+interval '2 minutes'
     OR p_recorded_at < now()-interval '14 days' THEN
    RETURN jsonb_build_object('ok',false,'code','NEEDS_REVIEW','message','Offline цаг хэт зөрсөн. EDIT дээр шалгана уу.');
  END IF;
  IF length(p_comment)>4000 OR length(p_operator)>200 THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID','message','Тайлбар эсвэл операторын нэр хэт урт.');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.status_types WHERE name=p_status) THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID','message','Төлөв сервер дээр байхгүй.');
  END IF;
  SELECT * INTO v_equipment FROM public.equipment WHERE id::text=p_equipment FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID','message','Техник олдсонгүй.');
  END IF;
  SELECT * INTO v_existing FROM public.ets_offline_request_log_v1 WHERE request_id=p_request;
  IF FOUND THEN
    IF v_existing.user_id<>v_user OR v_existing.equipment_key<>p_equipment
       OR v_existing.recorded_at<>p_recorded_at THEN
      RETURN jsonb_build_object('ok',false,'code','CONFLICT','message','Нэг ID өөр мэдээлэлтэй давхардсан.');
    END IF;
    RETURN jsonb_build_object('ok',true,'replayed',true,'event_id',v_existing.event_id);
  END IF;
  SELECT * INTO v_prev FROM public.equipment_events
   WHERE equipment_id=v_equipment.id AND end_time IS NULL
   ORDER BY start_time DESC,id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','CONFLICT','message','Нээлттэй төлөв олдсонгүй. EDIT дээр шалгана уу.');
  END IF;
  IF v_prev.start_time>=p_recorded_at THEN
    RETURN jsonb_build_object('ok',false,'code','CONFLICT','message','Бүртгэсэн цагаас хойш өөр төлөв орсон байна.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.equipment_events
            WHERE equipment_id=v_equipment.id AND start_time>v_prev.start_time) THEN
    RETURN jsonb_build_object('ok',false,'code','CONFLICT','message','Төлөвийн түүх өөрчлөгдсөн.');
  END IF;
  UPDATE public.equipment_events SET end_time=p_recorded_at
    WHERE id=v_prev.id AND end_time IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Concurrent timeline change'; END IF;
  INSERT INTO public.equipment_events(
    equipment_id,status,start_time,end_time,operator_name,smu,km,comment
  ) VALUES(
    v_equipment.id,p_status,p_recorded_at,NULL,
    NULLIF(btrim(p_operator),''),NULL,NULL,NULLIF(btrim(p_comment),'')
  ) RETURNING id::text INTO v_event_id;
  UPDATE public.equipment SET current_status=p_status WHERE id=v_equipment.id;
  INSERT INTO public.ets_offline_request_log_v1(request_id,user_id,equipment_key,event_id,recorded_at)
    VALUES(p_request,v_user,p_equipment,v_event_id,p_recorded_at);
  RETURN jsonb_build_object('ok',true,'replayed',false,'event_id',v_event_id);
END;
$$;
REVOKE ALL ON FUNCTION public.ets_offline_status_v1(uuid,text,text,timestamptz,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ets_offline_status_v1(uuid,text,text,timestamptz,text,text)
  TO authenticated;
COMMIT;
