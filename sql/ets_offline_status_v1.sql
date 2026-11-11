-- DRAFT: REVIEW / TEST BEFORE PRODUCTION.
-- Uses the EXISTING ets_status_actions_u5 request log and equipment_events audit trigger.
-- No duplicate history table. Replays status ONLY, never meter or production.
-- Existing online status RPC locks equipment_events in SHARE ROW EXCLUSIVE mode.
CREATE OR REPLACE FUNCTION public.ets_offline_status_v1(
  p_request uuid,
  p_equipment text,
  p_status text,
  p_recorded_at timestamptz,
  p_operator text DEFAULT NULL,
  p_comment text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  who uuid := auth.uid();
  person text;
  eq public.equipment%ROWTYPE;
  current_event public.equipment_events%ROWTYPE;
  saved_event public.equipment_events%ROWTYPE;
  receipt public.ets_status_actions_u5%ROWTYPE;
  eq_before jsonb;
  old_current jsonb;
  n integer;
BEGIN
  IF who IS NULL OR coalesce(auth.jwt()->'app_metadata'->>'role','')
    NOT IN ('event_editor','master','dispatcher','management','admin') THEN
    RAISE EXCEPTION 'Төлөв бүртгэх эрх хүрэхгүй' USING ERRCODE='42501';
  END IF;
  IF p_request IS NULL OR nullif(btrim(p_equipment),'') IS NULL
     OR nullif(btrim(p_status),'') IS NULL OR p_recorded_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID','message','Offline мэдээлэл дутуу');
  END IF;
  -- Serialize against the existing online status writer and Edit boundary operations.
  PERFORM set_config('lock_timeout','8s',true);
  LOCK TABLE public.equipment_events IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO eq FROM public.equipment WHERE id::text=p_equipment FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID','message','Техник олдсонгүй');
  END IF;
  -- At-least-once delivery is safe: replay is keyed by the client UUID.
  SELECT * INTO receipt FROM public.ets_status_actions_u5 WHERE request_id=p_request;
  IF FOUND THEN
    IF receipt.actor_id IS DISTINCT FROM who
       OR receipt.equipment_id IS DISTINCT FROM p_equipment
       OR receipt.action IS DISTINCT FROM 'set'
       OR receipt.resulting_event->>'status' IS DISTINCT FROM p_status
       OR (receipt.resulting_event->>'start_time')::timestamptz IS DISTINCT FROM p_recorded_at
       OR receipt.resulting_event->>'operator_name' IS DISTINCT FROM NULLIF(btrim(p_operator),'')
       OR receipt.resulting_event->>'comment' IS DISTINCT FROM NULLIF(btrim(p_comment),'') THEN
      RETURN jsonb_build_object('ok',false,'code','CONFLICT','message','Хүсэлтийн ID өөр мэдээлэлтэй давхардсан');
    END IF;
    RETURN jsonb_build_object('ok',true,'replayed',true,'event_id',receipt.resulting_event->>'id');
  END IF;
  IF p_recorded_at>clock_timestamp()+interval '2 minutes'
     OR p_recorded_at<clock_timestamp()-interval '14 days' THEN
    RETURN jsonb_build_object('ok',false,'code','NEEDS_REVIEW','message','Бүртгэлийн цагийг гараар шалгана уу');
  END IF;
  IF length(p_operator)>200 OR length(p_comment)>4000 THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID','message','Оператор эсвэл тайлбар хэт урт');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.status_types WHERE name=p_status) THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID','message','Төлөв лавлахад олдсонгүй');
  END IF;
  SELECT * INTO current_event FROM public.equipment_events
    WHERE equipment_id=eq.id ORDER BY start_time DESC,id DESC LIMIT 1 FOR UPDATE;
  SELECT count(*) INTO n FROM public.equipment_events
    WHERE equipment_id=eq.id AND end_time IS NULL;
  IF current_event.id IS NULL OR n<>1 OR current_event.end_time IS NOT NULL
     OR eq.current_status IS DISTINCT FROM current_event.status THEN
    RETURN jsonb_build_object('ok',false,'code','CONFLICT','message','Серверийн одоогийн төлөв зөрүүтэй. Edit дээр шалгана уу');
  END IF;
  IF p_recorded_at<=current_event.start_time THEN
    RETURN jsonb_build_object('ok',false,'code','CONFLICT','message','Энэ цагаас хойш өөр төлөв бүртгэгдсэн байна');
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.equipment_events
    WHERE equipment_id=eq.id AND id<>current_event.id
      AND (end_time IS NULL OR end_time>current_event.start_time)
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','CONFLICT','message','Өмнөх төлөвтэй давхцал байна');
  END IF;
  -- Commit both rows and the existing action receipt in ONE transaction.
  person:=coalesce(nullif(auth.jwt()->>'email',''),who::text);
  eq_before:=to_jsonb(eq);
  old_current:=to_jsonb(current_event);
  UPDATE public.equipment_events SET end_time=p_recorded_at WHERE id=current_event.id;
  INSERT INTO public.equipment_events(
    equipment_id,status,start_time,end_time,operator_name,smu,km,comment
  ) VALUES (
    eq.id,p_status,p_recorded_at,NULL,NULLIF(btrim(p_operator),''),
    NULL,NULL,NULLIF(btrim(p_comment),'')
  ) RETURNING * INTO saved_event;
  UPDATE public.equipment SET current_status=p_status WHERE id=eq.id RETURNING * INTO eq;
  INSERT INTO public.ets_status_actions_u5(
    request_id,equipment_id,action,actor_id,actor_name,undo_depth,
    previous_before,resulting_event,equipment_before,equipment_after
  ) VALUES (
    p_request,p_equipment,'set',who,person,0,
    old_current,to_jsonb(saved_event),eq_before,to_jsonb(eq)
  );
  RETURN jsonb_build_object('ok',true,'replayed',false,'event_id',saved_event.id::text);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.ets_offline_status_v1(
  uuid,text,text,timestamptz,text,text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ets_offline_status_v1(
  uuid,text,text,timestamptz,text,text
) TO authenticated;
