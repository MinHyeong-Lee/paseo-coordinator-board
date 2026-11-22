import { copyText } from "@getpaseo/plugin/client/ui";
import { useRef, useState, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { MAX_WORK_IMAGES, WORK_IMAGE_MIME_TYPES } from "../shared/operations";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { wrap } from "./route-editor";
import { checkPhotoSelection, clipboardPhotos, readWorkPhoto, type DraftPhoto, type PhotoError } from "./work-photos";

export function usePhotoDraft() {
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const latest = useRef<DraftPhoto[]>([]);
  const [error, setError] = useState<PhotoError | null>(null);
  const [reading, setReading] = useState(false);
  const readPending = useRef(false);
  const sequence = useRef(0);

  function update(next: DraftPhoto[]) {
    latest.current = next;
    setPhotos(next);
  }

  async function add(files: File[]) {
    if (!files.length || readPending.current) return;
    const reason = checkPhotoSelection(latest.current, files);
    setError(reason);
    if (reason) return;
    readPending.current = true;
    setReading(true);
    try {
      const batch: DraftPhoto[] = [];
      for (const file of files) {
        const image = await readWorkPhoto(file);
        batch.push({ id: ++sequence.current, name: file.name, size: file.size, image, preview: `data:${image.mimeType};base64,${image.data}` });
      }
      update([...latest.current, ...batch]);
    } catch {
      setError("read");
    } finally {
      readPending.current = false;
      setReading(false);
    }
  }

  function remove(id: number) {
    update(latest.current.filter(photo => photo.id !== id));
    setError(null);
  }

  function clear() {
    update([]);
    setError(null);
  }
  return { photos, latest, error, reading, readPending, add, remove, clear };
}

type Props = {
  children: ReactNode; theme: Theme; disabled: boolean; draft: ReturnType<typeof usePhotoDraft>;
  text: string; openSession?: () => void;
};

export function PhotoComposer({ children, theme, disabled, draft, text, openSession }: Props) {
  const { t } = useBoardLanguage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const supportsPicker = Platform.OS === "web" && typeof document !== "undefined" && typeof FileReader !== "undefined";
  const colors = theme.colors;
  if (!supportsPicker) {
    const open = async () => {
      setCopyFailed(false);
      if (text.trim()) {
        try { await copyText(text); }
        catch { setCopyFailed(true); return; }
      }
      openSession?.();
    };
    return <View style={{ gap: 6 }}>
      {children}
      {openSession && <Button theme={theme} disabled={disabled} onPress={() => void open()}
        label={text.trim() ? t("요청 글 복사 후 사진을 첨부할 세션 열기", "Copy request and open session to attach photos")
          : t("세션에서 사진 첨부하기", "Attach photos in the session")} />}
      {openSession && <Text style={{ color: colors.foregroundMuted }}>{text.trim()
        ? t("세션 입력창에 복사한 글을 붙여넣고 사진을 첨부해 보내세요.", "Paste the copied request into the session composer, attach photos, then send.")
        : t("사진은 코디네이터 세션의 입력창에서 선택해 보낼 수 있습니다.", "Select and send photos in the coordinator session composer.")}</Text>}
      {copyFailed && <Text accessibilityLiveRegion="polite" style={{ color: colors.statusDanger }}>{t("글을 복사할 수 없습니다. 입력한 글을 직접 복사한 뒤 코디네이터 세션을 여세요.", "Could not copy the draft. Copy it manually, then open the coordinator session.")}</Text>}
    </View>;
  }

  const locked = disabled || draft.reading;
  const errorText = {
    format: t("JPEG, PNG 또는 WebP 사진을 선택해 주세요.", "Choose JPEG, PNG or WebP photos."),
    count: t("사진은 요청당 최대 4장까지 첨부할 수 있습니다.", "Attach up to 4 photos per request."),
    size: t("각 사진은 0바이트보다 크고 5MiB 이하여야 합니다.", "Each photo must be nonempty and at most 5 MiB."),
    total: t("첨부한 사진의 합계는 12MiB 이하여야 합니다.", "Attached photos must total at most 12 MiB."),
    read: t("사진을 읽지 못했습니다. 파일을 다시 선택해 주세요.", "Could not read the photo. Select the file again."),
  };
  return <div style={{ display: "flex", flexDirection: "column", gap: 6 }} onPaste={event => {
    if (locked || draft.readPending.current) return;
    const files = clipboardPhotos(event.clipboardData);
    if (!files.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    void draft.add(files);
  }}>
    {children}
    <input ref={fileInput} type="file" multiple hidden accept={WORK_IMAGE_MIME_TYPES.join(",")} disabled={locked}
      onChange={event => {
        if (locked || draft.readPending.current) return;
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        void draft.add(files);
      }} />
    <View style={{ ...wrap, alignItems: "center" }}>
      <Button theme={theme} label={t("사진 추가", "Add photos")} disabled={locked || draft.photos.length >= MAX_WORK_IMAGES} onPress={() => fileInput.current?.click()} />
      <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted }}>{draft.reading ? t("사진 읽는 중…", "Reading photos…")
        : draft.photos.length ? t(`사진 ${draft.photos.length}장`, `${draft.photos.length} photo${draft.photos.length === 1 ? "" : "s"}`)
        : t("입력창에 스크린샷을 붙여넣을 수 있습니다.", "You can also paste a screenshot into the request.")}</Text>
    </View>
    {draft.photos.map((photo, index) => {
      const name = photo.name || t(`사진 ${photo.id}`, `Photo ${photo.id}`);
      const ordinal = index + 1;
      const distinguish = draft.photos.some(other => other.id !== photo.id && other.name === photo.name);
      const displayName = distinguish ? `${ordinal}. ${name}` : name;
      return <View key={photo.id} style={{ ...wrap, alignItems: "center" }}>
        <img src={photo.preview} alt={t(`첨부 사진 ${ordinal} · ${name}`, `Attached photo ${ordinal} · ${name}`)}
          width={56} height={56} decoding="async" style={{ objectFit: "contain", borderRadius: 4, backgroundColor: colors.surface0 }} />
        <Text selectable style={{ color: colors.foreground, flexShrink: 1 }}>{displayName}</Text>
        <Button theme={theme} label={t("제거", "Remove")} accessibilityLabel={t(`사진 제거 · ${displayName}`, `Remove photo · ${displayName}`)}
          disabled={locked} onPress={() => draft.remove(photo.id)} />
      </View>;
    })}
    {draft.error && <Text accessibilityLiveRegion="polite" style={{ color: colors.statusDanger }}>{errorText[draft.error]}</Text>}
  </div>;
}
