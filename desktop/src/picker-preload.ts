import { contextBridge, ipcRenderer } from "electron";
import { IPC, type PickerChoice, type PickerData } from "./channels.ts";

contextBridge.exposeInMainWorld("picker", {
  list: (): Promise<PickerData> => ipcRenderer.invoke(IPC.pickerList),
  choose: (choice: PickerChoice | null) => ipcRenderer.send(IPC.pickerChoose, choice),
});
