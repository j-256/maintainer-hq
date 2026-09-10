import { createContext, useContext } from "react";
import { createDateTimeFormatter } from "../shared/date-time";

export const DateTimeContext = createContext(createDateTimeFormatter());
export const useDateTime = () => useContext(DateTimeContext);
export function useSourceTime() {
  const date = useDateTime();
  return (value: string | null | undefined) =>
    value ? date.dateTime(value) : "Not received";
}
