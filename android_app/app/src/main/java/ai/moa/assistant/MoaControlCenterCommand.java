package ai.moa.assistant;

import java.util.Locale;

final class MoaControlCenterCommand {
    private MoaControlCenterCommand() {
    }

    static boolean isExplicitRequest(String text) {
        String command = safe(text).toLowerCase(Locale.US).replaceAll("\\s+", " ");
        return command.equals("/settings")
                || command.equals("/control center")
                || command.matches("^(open|show)( me)? (the )?(a\\.g\\.|ag|aggie|moa) (app|settings|control center|app ui)$")
                || command.matches("^(open|show)( me)? (the )?(app ui|control center|settings)( for (a\\.g\\.|ag|aggie|moa))?$");
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
