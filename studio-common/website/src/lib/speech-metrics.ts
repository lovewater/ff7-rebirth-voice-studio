export type SpeechMeasurement = {
  status: "ok" | "silent" | "missing" | "error" | "pending";
  pending?: boolean;
  error?: string;
  version?: string;
  peakRatio?: number;
  minSilenceMs?: number;
  durationS?: number;
  silenceS?: number;
  activeS?: number;
  silenceCount?: number;
  silences?: { startS: number; endS: number }[];
  units?: number | null;
  readingStatus?: "ok" | "short" | "missing" | "review_reading";
  rate?: number | null;
};

export type SpeechComparison = {
  items: {
    key: string;
    label: string;
    language: "jp" | "cn";
    measurement: SpeechMeasurement;
  }[];
};
