with open('app.js','r',encoding='utf-8') as f:
    s=f.read()
old1='        applyFiltersAndRender();\n        renderIssues();\n        if (els.meta) {'
new1='        applyFiltersAndRender();\n        renderIssues();\n        try{ saveHistoryLocal({ code: (cm&&typeof cm.getValue==="function")?cm.getValue():(document.getElementById("editor")&&document.getElementById("editor").value)||"", issues: allIssues||[], meta: lastMeta||currentMeta||{}, mode: (els.mode&&els.mode.value)||((lastMeta&&lastMeta.mode))||"hybrid", filename: "snippet.py" }); }catch(e){}\n        if (els.meta) {'
if old1 in s:
    s=s.replace(old1,new1)
    print('1')
old2='        clearIssueLines();\n        applyFiltersAndRender();\n        renderIssues();\n        if (els.meta) {'
new2='        clearIssueLines();\n        applyFiltersAndRender();\n        renderIssues();\n        try{ saveHistoryLocal({ code: (cm&&typeof cm.getValue==="function")?cm.getValue():(document.getElementById("editor")&&document.getElementById("editor").value)||"", issues: allIssues||[], meta: lastMeta||currentMeta||{}, mode: "mock", filename: "snippet.py" }); }catch(e){}\n        if (els.meta) {'
if old2 in s:
    s=s.replace(old2,new2)
    print('2')
open('app.js','w',encoding='utf-8').write(s)
