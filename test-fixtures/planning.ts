import { useQueryClient } from "@tanstack/react-query";
import { savePlanningDoc, toSaveRequest, PlanningDocDraft } from "./api";
import { queryKeys } from "./queryKeys";
import { showToast } from "./toast";

export function usePlanningDocSave(batchRecordId: string) {
  const queryClient = useQueryClient();

  const handleSave = async (draft: PlanningDocDraft) => {
    try {
      const saved = await savePlanningDoc(batchRecordId, toSaveRequest(draft));
      queryClient.setQueryData(
        queryKeys.batchRecords.planningDoc(batchRecordId),
        saved
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeys.batchRecords.constants(batchRecordId),
      });
      showToast("Planning doc saved", "success");
    } catch {
      // apiService interceptor surfaces the error toast
    }
  };

  return handleSave;
}
