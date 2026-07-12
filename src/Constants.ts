import * as path from "path";
import * as fs from "fs";

// srcML is bundled with the extension under <extensionRoot>/bin/srcml-win so it
// works on any machine and ships inside the .vsix. This module compiles to
// <extensionRoot>/out/Constants.js, hence the ".." to reach the extension root.
// Precedence: SRCML_PATH env override > bundled binary > "srcml" on the PATH.
const bundledWindowsSrcml = path.join(__dirname, "..", "bin", "srcml-win", "bin", "srcml.exe");
const resolveWindowsSrcml = (): string => {
    if (process.env.SRCML_PATH) { return process.env.SRCML_PATH; }
    if (fs.existsSync(bundledWindowsSrcml)) { return bundledWindowsSrcml; }
    return "srcml"; // fall back to a srcml on the system PATH
};

export const Constants = {
    TAG_TABLE_JSON: "tagTable.json",
    RULE_TABLE_JSON: "ruleTable.json",
    TEMP_XML_FILE: "tempResultXmlFile.xml",
    TEMP_JAVA_FILE: "tempExprFile.java",
    TEMP_JAVA_FILE_TESTING:"temptestfile.java",
    XML_HEADER: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    LEARNING_DR_DIRECTORY:"/LearningDR",
    SRCML_PATH_WINDOWS: resolveWindowsSrcml(),
    SRCML_PATH_MAC: process.env.SRCML_PATH || "/usr/local/bin/srcml",
    SRCML_PATH_LINUX: process.env.SRCML_PATH || "/usr/bin/srcml",
    DEBOUNCER_DELAY:3000

};
