# 설치형 서버 프로젝트 작업 지침

- 기존 예상질의대시보드와 분리된 Windows 사내망 서버 프로젝트다.
- 요청에 필요한 최소 범위를 수정하고 기존 언어와 코드를 유지한다.
- 사용자가 명시적으로 요청하기 전에는 커밋하거나 푸시하지 않는다.
- .env, server-data, runtime, server-vendor, server-package 및 생성 ZIP은 Git에 넣지 않는다.
- 변경과 관련된 검사를 먼저 수행한다. 설치 패키지는 scripts/build-server-package.ps1로 만든다.
- 원래 웹 배포 프로젝트는 별도 폴더이므로 함께 수정하지 않는다.